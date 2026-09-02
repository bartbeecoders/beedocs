using System.Buffers.Text;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace BeeDocs.Api.Services;

/// <summary>How a token validation ended. Only <see cref="Valid"/> carries claims.</summary>
public enum RbaTokenStatus
{
    Valid,

    /// <summary>The token itself is bad: malformed, wrong algorithm, wrong signature, or expired.</summary>
    Invalid,

    /// <summary>
    /// No public key to check against: the JWKS could not be fetched (and nothing
    /// was cached) or held no usable RSA key. Not the caller's fault — this is
    /// the server unable to reach or use RBA, and must surface as "unavailable",
    /// never as "your sign-in could not be verified".
    /// </summary>
    JwksUnavailable,
}

public sealed record RbaTokenValidation(RbaTokenStatus Status, JsonDocument? Claims = null);

/// <summary>
/// Verifies RBA-issued JWTs (RS256) against the public keys RBA serves at
/// <c>/.well-known/jwks.json</c>. Hand-rolled on the BCL rather than pulling in
/// the IdentityModel stack: BeeDocs accepts exactly one shape of token — RS256,
/// signed by a key in that JWKS, unexpired — and rejects everything else, so
/// fifty lines of explicit checks beat a configurable validator here.
///
/// The JWKS is public material and changes only when RBA rotates its key, so it
/// is cached process-wide; an unknown <c>kid</c> forces one refetch before the
/// token is rejected, which is how a rotation heals without a restart.
///
/// Every rejection logs its reason: a failed login here is a two-machine
/// diagnosis (browser→RBA worked, server→RBA is the question), and a silent
/// null makes DNS, TLS-trust, wrong-path and wrong-algorithm failures all look
/// like "bad token" to the operator.
/// </summary>
public static class RbaTokenValidator
{
    private sealed record CachedJwks(DateTimeOffset FetchedAt, IReadOnlyList<JwksKey> Keys);

    public sealed record JwksKey(string? Kid, byte[] Modulus, byte[] Exponent);

    private static readonly TimeSpan CacheLifetime = TimeSpan.FromMinutes(10);

    private static readonly ConcurrentDictionary<string, CachedJwks> Cache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Parse a pasted JWKS document into usable RSA keys. Null when it is not a
    /// JWKS at all; an empty list when it parses but holds no RSA key. Shared by
    /// the settings-save validation and the pinned-key verification path.
    /// </summary>
    public static IReadOnlyList<JwksKey>? TryParseKeys(string jwksJson)
    {
        try
        {
            using var doc = JsonDocument.Parse(jwksJson);
            return ParseKeys(doc);
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or FormatException
                                      or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>
    /// The claims of a genuine, unexpired RBA token, or a status saying why not.
    /// The caller reads identity from these claims only — never from anything
    /// else the browser sent.
    /// </summary>
    /// <param name="pinnedJwks">Pasted JWKS JSON to verify against first; empty for none.</param>
    /// <param name="allowNetwork">
    /// False when the server has no route to RBA (offline mode): verification
    /// then uses only the pinned keys and never dials <paramref name="jwksBaseUrl"/>.
    /// </param>
    public static async Task<RbaTokenValidation> ValidateAsync(
        HttpClient http,
        string jwksBaseUrl,
        string pinnedJwks,
        bool allowNetwork,
        string token,
        ILogger logger,
        CancellationToken ct)
    {
        var parts = token.Split('.');
        if (parts.Length != 3)
        {
            logger.LogWarning("RBA token rejected: not a three-part JWT.");
            return new RbaTokenValidation(RbaTokenStatus.Invalid);
        }

        byte[] headerBytes, payloadBytes, signature;
        try
        {
            headerBytes = Base64Url.DecodeFromChars(parts[0]);
            payloadBytes = Base64Url.DecodeFromChars(parts[1]);
            signature = Base64Url.DecodeFromChars(parts[2]);
        }
        catch (FormatException)
        {
            logger.LogWarning("RBA token rejected: parts are not base64url.");
            return new RbaTokenValidation(RbaTokenStatus.Invalid);
        }

        string? kid;
        using (var header = JsonDocument.Parse(headerBytes))
        {
            // RS256 only. Accepting whatever "alg" says is the classic JWT
            // confusion bug — an "alg":"none" or HMAC-with-public-key token
            // must die here, not reach the RSA verify below.
            if (!header.RootElement.TryGetProperty("alg", out var alg)
                || !string.Equals(alg.GetString(), "RS256", StringComparison.Ordinal))
            {
                logger.LogWarning(
                    "RBA token rejected: alg is '{Alg}', only RS256 is accepted. If RBA signs its " +
                    "tokens with a different algorithm, the token sign-in path cannot be used.",
                    header.RootElement.TryGetProperty("alg", out var a) ? a.GetString() : "(none)");
                return new RbaTokenValidation(RbaTokenStatus.Invalid);
            }

            kid = header.RootElement.TryGetProperty("kid", out var k) ? k.GetString() : null;
        }

        var signedInput = Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}");

        var verified = false;
        var sawKeys = 0;

        // Pinned keys first: they are the only option offline, and online they
        // save the round trip on every login.
        if (pinnedJwks.Length > 0)
        {
            var pinned = TryParseKeys(pinnedJwks);
            if (pinned is null)
                logger.LogError("The pinned RBA JWKS in settings does not parse — re-paste it from {Url}.", JwksUrl(jwksBaseUrl));
            else
            {
                sawKeys = pinned.Count;
                verified = Verify(pinned, kid, signedInput, signature);
                if (!verified && !allowNetwork)
                {
                    logger.LogWarning(
                        "RBA token rejected: signature matched none of the {Count} pinned key(s) (token kid: {Kid}). " +
                        "If RBA rotated its keys, paste the current JWKS into the sign-in settings.",
                        pinned.Count, kid ?? "(none)");
                    return new RbaTokenValidation(RbaTokenStatus.Invalid);
                }
            }

        }

        if (!verified && allowNetwork)
        {
            var keys = await GetKeysAsync(http, jwksBaseUrl, forceRefresh: false, logger, ct);
            verified = Verify(keys, kid, signedInput, signature);
            if (!verified)
            {
                // Unknown kid or stale cache after a key rotation: one refetch, then no.
                keys = await GetKeysAsync(http, jwksBaseUrl, forceRefresh: true, logger, ct);
                if (keys.Count == 0 && sawKeys == 0)
                {
                    // Nothing to verify against even after a fresh fetch: the JWKS is
                    // unreachable, not JSON, or empty. That is a server-side outage or
                    // misconfiguration (DNS, TLS trust, wrong base URL), not a bad token.
                    logger.LogError(
                        "RBA token could not be verified: no usable key from {Url}. " +
                        "Check that the BeeDocs server can reach that URL and trusts its certificate, " +
                        "or switch the sign-in settings to offline mode with a pasted JWKS.",
                        JwksUrl(jwksBaseUrl));
                    return new RbaTokenValidation(RbaTokenStatus.JwksUnavailable);
                }

                verified = Verify(keys, kid, signedInput, signature);
                if (!verified)
                {
                    logger.LogWarning(
                        "RBA token rejected: signature matched none of the {Count} JWKS key(s) (token kid: {Kid}).",
                        keys.Count + sawKeys, kid ?? "(none)");
                    return new RbaTokenValidation(RbaTokenStatus.Invalid);
                }
            }
        }

        if (!verified)
        {
            // Offline with nothing pinned (or a pinned document that does not
            // parse): there is no key at all, and no route to fetch one.
            logger.LogError(
                "RBA token could not be verified: offline mode has no usable pinned JWKS. " +
                "Paste the JSON from {Url} into the sign-in settings.",
                JwksUrl(jwksBaseUrl));
            return new RbaTokenValidation(RbaTokenStatus.JwksUnavailable);
        }

        var payload = JsonDocument.Parse(payloadBytes);

        // Lifetime, with a minute of skew either way — RBA and BeeDocs are
        // different machines with different clocks.
        var now = DateTimeOffset.UtcNow;
        if (!payload.RootElement.TryGetProperty("exp", out var exp)
            || !exp.TryGetInt64(out var expSeconds)
            || DateTimeOffset.FromUnixTimeSeconds(expSeconds) < now - TimeSpan.FromMinutes(1))
        {
            logger.LogWarning("RBA token rejected: missing or past exp claim.");
            payload.Dispose();
            return new RbaTokenValidation(RbaTokenStatus.Invalid);
        }

        if (payload.RootElement.TryGetProperty("nbf", out var nbf)
            && nbf.TryGetInt64(out var nbfSeconds)
            && DateTimeOffset.FromUnixTimeSeconds(nbfSeconds) > now + TimeSpan.FromMinutes(1))
        {
            logger.LogWarning("RBA token rejected: nbf claim is in the future.");
            payload.Dispose();
            return new RbaTokenValidation(RbaTokenStatus.Invalid);
        }

        return new RbaTokenValidation(RbaTokenStatus.Valid, payload);
    }

    /// <summary>
    /// Settings-page probe: can this server fetch the JWKS, and does it hold a
    /// key? Null when all is well, else a sentence saying what is wrong — the
    /// admin Test button reports it, because the basic-login probe alone cannot
    /// see that the token sign-in path is broken.
    /// </summary>
    public static async Task<string?> ProbeJwksAsync(
        HttpClient http,
        string jwksBaseUrl,
        ILogger logger,
        CancellationToken ct)
    {
        var url = JwksUrl(jwksBaseUrl);
        try
        {
            using var doc = JsonDocument.Parse(await http.GetByteArrayAsync(url, ct));
            var keys = ParseKeys(doc);
            if (keys.Count == 0)
                return $"The JWKS at {url} holds no RSA key, so browser sign-in tokens cannot be verified.";

            Cache[jwksBaseUrl] = new CachedJwks(DateTimeOffset.UtcNow, keys);
            return null;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException
                                      or KeyNotFoundException or FormatException)
        {
            logger.LogWarning(e, "RBA JWKS probe of {Url} failed.", url);
            return $"The BeeDocs server could not fetch the JWKS from {url} ({Reason(e)}), " +
                   "so browser sign-in will fail even though RBA answers the browser. " +
                   "Check DNS, certificate trust and the base URL from the server itself.";
        }
    }

    private static string Reason(Exception e) =>
        e switch
        {
            JsonException => "the answer was not JSON",
            TaskCanceledException => "timed out",
            _ => e.InnerException?.Message ?? e.Message,
        };

    private static string JwksUrl(string jwksBaseUrl) => $"{jwksBaseUrl}/.well-known/jwks.json";

    private static bool Verify(IReadOnlyList<JwksKey> keys, string? kid, byte[] signedInput, byte[] signature)
    {
        // Match by kid when both sides have one; a keyless token is tried
        // against every published key (there is typically exactly one).
        var candidates = kid is null ? keys : keys.Where(k => k.Kid == kid || k.Kid is null).ToList();

        foreach (var key in candidates)
        {
            using var rsa = RSA.Create();
            try
            {
                rsa.ImportParameters(new RSAParameters { Modulus = key.Modulus, Exponent = key.Exponent });
            }
            catch (CryptographicException)
            {
                continue;
            }

            if (rsa.VerifyData(signedInput, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))
                return true;
        }

        return false;
    }

    private static List<JwksKey> ParseKeys(JsonDocument doc)
    {
        var keys = new List<JwksKey>();
        if (doc.RootElement.TryGetProperty("keys", out var array))
        {
            foreach (var key in array.EnumerateArray())
            {
                if (!string.Equals(key.GetProperty("kty").GetString(), "RSA", StringComparison.Ordinal))
                    continue;

                keys.Add(new JwksKey(
                    key.TryGetProperty("kid", out var k) ? k.GetString() : null,
                    Base64Url.DecodeFromChars(key.GetProperty("n").GetString()!),
                    Base64Url.DecodeFromChars(key.GetProperty("e").GetString()!)));
            }
        }

        return keys;
    }

    private static async Task<IReadOnlyList<JwksKey>> GetKeysAsync(
        HttpClient http,
        string jwksBaseUrl,
        bool forceRefresh,
        ILogger logger,
        CancellationToken ct)
    {
        if (!forceRefresh
            && Cache.TryGetValue(jwksBaseUrl, out var cached)
            && DateTimeOffset.UtcNow - cached.FetchedAt < CacheLifetime)
        {
            return cached.Keys;
        }

        try
        {
            using var doc = JsonDocument.Parse(
                await http.GetByteArrayAsync(JwksUrl(jwksBaseUrl), ct));

            var keys = ParseKeys(doc);
            Cache[jwksBaseUrl] = new CachedJwks(DateTimeOffset.UtcNow, keys);
            return keys;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException
                                      or KeyNotFoundException or FormatException)
        {
            // Unreachable or malformed JWKS: fall back to whatever was cached —
            // stale public keys still verify genuine tokens — else no keys, and
            // every token is rejected rather than trusted. The log line is the
            // operator's only window into DNS/TLS/path trouble on this hop.
            logger.LogWarning(e, "Fetching the RBA JWKS from {Url} failed.", JwksUrl(jwksBaseUrl));
            return Cache.TryGetValue(jwksBaseUrl, out var stale) ? stale.Keys : [];
        }
    }
}
