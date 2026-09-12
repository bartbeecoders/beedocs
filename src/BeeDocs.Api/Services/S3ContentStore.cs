using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;
using BeeDocs.Api.Models;

namespace BeeDocs.Api.Services;

/// <summary>
/// S3-compatible backend: AWS S3 itself and everything that speaks its API
/// (MinIO, Ceph RGW, Cloudflare R2, Backblaze B2, Wasabi, Hetzner, …). One
/// object per body, addressed by the suggested key under the provider's optional
/// prefix. Hand-rolled SigV4 over <see cref="HttpClient"/> rather than the AWS
/// SDK: the four verbs BeeDocs needs (PUT, GET, DELETE, ListObjectsV2) are a
/// page of code, the SDK is a 10 MB dependency tuned for AWS specifically, and
/// the self-hosted services this exists for are exactly where the SDK's
/// defaults (checksum trailers, virtual-hosted addressing, region discovery)
/// need the most overriding.
/// </summary>
public sealed class S3ContentStore : IContentStore, IBackupStore
{
    // Shared across stores and providers: connections pool per host, and the
    // timeout is per request via the caller's token, not the client (a 2 GB
    // backup upload must not trip a client-wide limit).
    private static readonly HttpClient Http = new(new SocketsHttpHandler
    {
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        AllowAutoRedirect = false,
    })
    {
        Timeout = Timeout.InfiniteTimeSpan,
    };

    private const string EmptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    private const string UnsignedPayload = "UNSIGNED-PAYLOAD";

    private readonly string _providerName;
    private readonly string _bucket;
    private readonly string _region;
    private readonly string _accessKey;
    private readonly string _secretKey;
    private readonly string? _prefix;
    private readonly bool _pathStyle;
    private readonly Uri _endpoint;

    public S3ContentStore(StorageProviderSecret secret)
    {
        _providerName = secret.Name;
        _bucket = secret.S3Bucket ?? throw new ContentUnavailableException(secret.Name, "The S3 provider has no bucket.");
        _region = string.IsNullOrWhiteSpace(secret.S3Region) ? StorageProviderKinds.DefaultS3Region : secret.S3Region;
        _accessKey = secret.S3AccessKey ?? string.Empty;
        _secretKey = secret.S3SecretKey ?? string.Empty;
        _prefix = secret.S3Prefix;
        _pathStyle = secret.S3PathStyle;
        _endpoint = new Uri(
            string.IsNullOrWhiteSpace(secret.S3Endpoint) ? $"https://s3.{_region}.amazonaws.com" : secret.S3Endpoint,
            UriKind.Absolute);
    }

    /// <summary>Where objects land, for the test message.</summary>
    public string Location => _prefix is null ? _bucket : $"{_bucket}/{_prefix}";

    // ----- IContentStore -----

    public async Task<string> PutAsync(string suggestedKey, string body, string? existingKey, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        using var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new("text/plain") { CharSet = "utf-8" };
        using var response = await SendAsync(HttpMethod.Put, suggestedKey, null, content, Hex(SHA256.HashData(bytes)), ct);
        await EnsureSuccessAsync(response, $"storing '{suggestedKey}'", ct);
        return suggestedKey;
    }

    public async Task<string> GetAsync(string key, CancellationToken ct)
    {
        using var response = await SendAsync(HttpMethod.Get, key, null, null, EmptyPayloadHash, ct);
        await EnsureSuccessAsync(response, $"reading '{key}'", ct);
        return await response.Content.ReadAsStringAsync(ct);
    }

    public async Task DeleteAsync(string key, CancellationToken ct)
    {
        using var response = await SendAsync(HttpMethod.Delete, key, null, null, EmptyPayloadHash, ct);
        // S3 answers 204 whether or not the object existed; a 404 from a stricter
        // clone still means "gone", which is the outcome asked for.
        if (response.StatusCode == HttpStatusCode.NotFound) return;
        await EnsureSuccessAsync(response, $"deleting '{key}'", ct);
    }

    public async Task<StorageTestResultDto> TestAsync(CancellationToken ct)
    {
        try
        {
            const string probeKey = "._beedocs-probe";
            await PutAsync(probeKey, "probe", null, ct);
            var back = await GetAsync(probeKey, ct);
            await DeleteAsync(probeKey, ct);
            return back == "probe"
                ? new(true, $"Connected. Bucket '{Location}' is writable at {_endpoint.Host}.")
                : new(false, "The probe object came back with different contents.");
        }
        catch (Exception ex)
        {
            return new(false, ex.GetBaseException().Message);
        }
    }

    /// <summary>
    /// PUT the bucket itself. AWS demands a <c>LocationConstraint</c> for every
    /// region but us-east-1 and rejects one *for* us-east-1; MinIO and friends
    /// accept either, so the body follows AWS's rule. A bucket that already
    /// belongs to this account is a success — the admin wanted it to exist —
    /// while a name taken by someone else (global on AWS) is the one failure
    /// that a different name fixes, so the message says so. Ends with the same
    /// probe as <see cref="TestAsync"/>: a bucket the key can create but not
    /// write to (a policy quirk on some services) should not show green.
    /// </summary>
    public async Task<StorageTestResultDto> CreateBucketAsync(CancellationToken ct)
    {
        try
        {
            HttpContent? body = null;
            var payloadHash = EmptyPayloadHash;
            if (!string.Equals(_region, StorageProviderKinds.DefaultS3Region, StringComparison.OrdinalIgnoreCase))
            {
                var xml = Encoding.UTF8.GetBytes(
                    "<CreateBucketConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">"
                    + $"<LocationConstraint>{new XText(_region)}</LocationConstraint>"
                    + "</CreateBucketConfiguration>");
                body = new ByteArrayContent(xml);
                body.Headers.ContentType = new("application/xml");
                payloadHash = Hex(SHA256.HashData(xml));
            }

            string outcome;
            using (body)
            using (var response = await SendAsync(HttpMethod.Put, string.Empty, null, body, payloadHash, ct, bucketRequest: true))
            {
                if (response.IsSuccessStatusCode)
                {
                    outcome = $"Bucket '{_bucket}' created at {_endpoint.Host}.";
                }
                else
                {
                    var (code, message) = await ReadErrorAsync(response, ct);
                    var conflict = response.StatusCode == HttpStatusCode.Conflict;
                    if (conflict && string.Equals(code, "BucketAlreadyOwnedByYou", StringComparison.OrdinalIgnoreCase))
                        outcome = $"Bucket '{_bucket}' already exists at {_endpoint.Host}.";
                    else if (conflict && string.Equals(code, "BucketAlreadyExists", StringComparison.OrdinalIgnoreCase))
                        return new(false, $"The name '{_bucket}' is already taken by another account on {_endpoint.Host} — bucket names are global there. Choose another name.");
                    else
                        throw Failure(response, $"creating bucket '{_bucket}'", code, message);
                }
            }

            var probe = await TestAsync(ct);
            return probe.Ok
                ? new(true, $"{outcome} It is writable.")
                : new(false, $"{outcome} But it is not writable: {probe.Message}");
        }
        catch (Exception ex)
        {
            return new(false, ex.GetBaseException().Message);
        }
    }

    // ----- IBackupStore -----

    public async Task UploadAsync(string key, Stream content, long length, CancellationToken ct)
    {
        // SigV4 signs the payload hash. A seekable stream (the backup service
        // hands over a file) is hashed in a first pass; otherwise the request
        // goes out unsigned-payload, which S3 accepts over TLS.
        var hash = UnsignedPayload;
        if (content.CanSeek)
        {
            var start = content.Position;
            hash = Hex(await SHA256.HashDataAsync(content, ct));
            content.Position = start;
        }

        using var body = new StreamContent(content);
        body.Headers.ContentLength = length;
        body.Headers.ContentType = new("application/zip");
        using var response = await SendAsync(HttpMethod.Put, key, null, body, hash, ct);
        await EnsureSuccessAsync(response, $"uploading '{key}'", ct);
    }

    public async Task DownloadAsync(string key, Stream destination, CancellationToken ct)
    {
        using var response = await SendAsync(HttpMethod.Get, key, null, null, EmptyPayloadHash, ct, HttpCompletionOption.ResponseHeadersRead);
        await EnsureSuccessAsync(response, $"downloading '{key}'", ct);
        await response.Content.CopyToAsync(destination, ct);
    }

    public async Task<IReadOnlyList<StoredObject>> ListAsync(string prefix, CancellationToken ct)
    {
        var list = new List<StoredObject>();
        var fullPrefix = FullKey(prefix);
        var strip = fullPrefix.Length - prefix.Length;
        string? token = null;
        do
        {
            var query = new SortedDictionary<string, string>(StringComparer.Ordinal)
            {
                ["list-type"] = "2",
                ["prefix"] = fullPrefix,
                ["max-keys"] = "1000",
            };
            if (token is not null) query["continuation-token"] = token;

            using var response = await SendAsync(HttpMethod.Get, string.Empty, query, null, EmptyPayloadHash, ct, bucketRequest: true);
            await EnsureSuccessAsync(response, $"listing '{prefix}'", ct);
            var xml = XDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            var root = xml.Root ?? throw new ContentUnavailableException(_providerName, "S3 returned an empty listing.");

            foreach (var item in root.Elements().Where(e => e.Name.LocalName == "Contents"))
            {
                var key = Child(item, "Key");
                if (key is null || key.Length < strip) continue;
                var size = long.TryParse(Child(item, "Size"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : 0;
                DateTimeOffset? modified = DateTimeOffset.TryParse(
                    Child(item, "LastModified"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var m)
                    ? m
                    : null;
                list.Add(new StoredObject(key[strip..], size, modified));
            }

            var truncated = string.Equals(Child(root, "IsTruncated"), "true", StringComparison.OrdinalIgnoreCase);
            token = truncated ? Child(root, "NextContinuationToken") : null;
        } while (!string.IsNullOrEmpty(token));
        return list;
    }

    // ----- SigV4 -----

    private string FullKey(string key) => _prefix is null ? key : $"{_prefix}/{key}";

    private async Task<HttpResponseMessage> SendAsync(
        HttpMethod method,
        string key,
        SortedDictionary<string, string>? query,
        HttpContent? content,
        string payloadHash,
        CancellationToken ct,
        HttpCompletionOption completion = HttpCompletionOption.ResponseContentRead,
        bool bucketRequest = false)
    {
        var objectPath = bucketRequest ? string.Empty : FullKey(key);
        var encodedPath = EncodePath(objectPath);

        string host;
        string canonicalUri;
        if (_pathStyle)
        {
            host = _endpoint.IsDefaultPort ? _endpoint.Host : $"{_endpoint.Host}:{_endpoint.Port}";
            canonicalUri = "/" + _bucket + (encodedPath.Length > 0 ? "/" + encodedPath : string.Empty);
        }
        else
        {
            host = _endpoint.IsDefaultPort ? $"{_bucket}.{_endpoint.Host}" : $"{_bucket}.{_endpoint.Host}:{_endpoint.Port}";
            canonicalUri = "/" + encodedPath;
        }
        // A bucket-level request (listing) must address the bucket itself, "/".
        if (bucketRequest && !_pathStyle) canonicalUri = "/";

        var canonicalQuery = query is null
            ? string.Empty
            : string.Join("&", query.Select(kv => $"{Encode(kv.Key)}={Encode(kv.Value)}"));

        var now = DateTimeOffset.UtcNow;
        var amzDate = now.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture);
        var dateStamp = now.ToString("yyyyMMdd", CultureInfo.InvariantCulture);
        var scope = $"{dateStamp}/{_region}/s3/aws4_request";

        const string signedHeaders = "host;x-amz-content-sha256;x-amz-date";
        var canonicalRequest = string.Join("\n",
            method.Method,
            canonicalUri,
            canonicalQuery,
            $"host:{host}\nx-amz-content-sha256:{payloadHash}\nx-amz-date:{amzDate}\n",
            signedHeaders,
            payloadHash);

        var stringToSign = string.Join("\n",
            "AWS4-HMAC-SHA256",
            amzDate,
            scope,
            Hex(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalRequest))));

        var kDate = Hmac(Encoding.UTF8.GetBytes("AWS4" + _secretKey), dateStamp);
        var kRegion = Hmac(kDate, _region);
        var kService = Hmac(kRegion, "s3");
        var kSigning = Hmac(kService, "aws4_request");
        var signature = Hex(Hmac(kSigning, stringToSign));

        var url = new UriBuilder(_endpoint.Scheme, _pathStyle ? _endpoint.Host : $"{_bucket}.{_endpoint.Host}", _endpoint.Port)
        {
            Path = canonicalUri,
            Query = canonicalQuery,
        }.Uri;

        var request = new HttpRequestMessage(method, url) { Content = content };
        request.Headers.Host = host;
        request.Headers.TryAddWithoutValidation("x-amz-date", amzDate);
        request.Headers.TryAddWithoutValidation("x-amz-content-sha256", payloadHash);
        request.Headers.TryAddWithoutValidation("Authorization",
            $"AWS4-HMAC-SHA256 Credential={_accessKey}/{scope}, SignedHeaders={signedHeaders}, Signature={signature}");

        try
        {
            return await Http.SendAsync(request, completion, ct);
        }
        catch (HttpRequestException ex)
        {
            throw new ContentUnavailableException(
                _providerName, $"S3 endpoint {_endpoint.Host} could not be reached: {ex.GetBaseException().Message}", ex);
        }
    }

    private async Task EnsureSuccessAsync(HttpResponseMessage response, string what, CancellationToken ct)
    {
        if (response.IsSuccessStatusCode) return;
        var (code, message) = await ReadErrorAsync(response, ct);
        throw Failure(response, what, code, message);
    }

    private ContentUnavailableException Failure(HttpResponseMessage response, string what, string? code, string? message)
    {
        var detail = string.Join(": ", new[] { code, message }.Where(s => !string.IsNullOrWhiteSpace(s)));
        return new ContentUnavailableException(
            _providerName,
            $"S3 returned {(int)response.StatusCode} {response.ReasonPhrase} {what}"
            + (detail.Length > 0 ? $" ({detail})." : "."));
    }

    /// <summary>The S3 error document's Code and Message, or nulls when the body is not one.</summary>
    private static async Task<(string? Code, string? Message)> ReadErrorAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            var body = await response.Content.ReadAsStringAsync(ct);
            if (!body.TrimStart().StartsWith('<')) return (null, null);
            var xml = XDocument.Parse(body);
            return (Child(xml.Root, "Code"), Child(xml.Root, "Message"));
        }
        catch
        {
            // The status code is the message then.
            return (null, null);
        }
    }

    private static string? Child(XElement? parent, string localName) =>
        parent?.Elements().FirstOrDefault(e => e.Name.LocalName == localName)?.Value;

    private static byte[] Hmac(byte[] key, string data) =>
        HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(data));

    private static string Hex(byte[] bytes) => Convert.ToHexString(bytes).ToLowerInvariant();

    /// <summary>RFC 3986 unreserved characters pass; everything else is %XX (uppercase), space included.</summary>
    internal static string Encode(string value)
    {
        var sb = new StringBuilder(value.Length + 8);
        foreach (var b in Encoding.UTF8.GetBytes(value))
        {
            var c = (char)b;
            if (c is (>= 'A' and <= 'Z') or (>= 'a' and <= 'z') or (>= '0' and <= '9') or '-' or '_' or '.' or '~')
                sb.Append(c);
            else
                sb.Append('%').Append(Convert.ToHexString([b]));
        }
        return sb.ToString();
    }

    /// <summary>Each segment encoded, '/' kept — S3 signs the single-encoded path.</summary>
    internal static string EncodePath(string path) =>
        string.Join("/", path.Split('/').Select(Encode));
}
