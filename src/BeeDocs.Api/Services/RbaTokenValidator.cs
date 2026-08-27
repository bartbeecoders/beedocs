using System.Buffers.Text;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace BeeDocs.Api.Services;

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
/// </summary>
public static class RbaTokenValidator
{
    private sealed record CachedJwks(DateTimeOffset FetchedAt, IReadOnlyList<JwksKey> Keys);

    public sealed record JwksKey(string? Kid, byte[] Modulus, byte[] Exponent);

    private static readonly TimeSpan CacheLifetime = TimeSpan.FromMinutes(10);

    private static readonly ConcurrentDictionary<string, CachedJwks> Cache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Null when the token is not a genuine, unexpired RBA token; otherwise the
    /// payload claims. The caller reads identity from these claims only — never
    /// from anything else the browser sent.
    /// </summary>
    public static async Task<JsonDocument?> ValidateAsync(
        HttpClient http,
        string jwksBaseUrl,
        string token,
        CancellationToken ct)
    {
        var parts = token.Split('.');
        if (parts.Length != 3) return null;

        byte[] headerBytes, payloadBytes, signature;
        try
        {
            headerBytes = Base64Url.DecodeFromChars(parts[0]);
            payloadBytes = Base64Url.DecodeFromChars(parts[1]);
            signature = Base64Url.DecodeFromChars(parts[2]);
        }
        catch (FormatException)
        {
            return null;
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
                return null;
            }

            kid = header.RootElement.TryGetProperty("kid", out var k) ? k.GetString() : null;
        }

        var signedInput = Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}");
        if (!await VerifySignatureAsync(http, jwksBaseUrl, kid, signedInput, signature, ct))
            return null;

        var payload = JsonDocument.Parse(payloadBytes);

        // Lifetime, with a minute of skew either way — RBA and BeeDocs are
        // different machines with different clocks.
        var now = DateTimeOffset.UtcNow;
        if (!payload.RootElement.TryGetProperty("exp", out var exp)
            || !exp.TryGetInt64(out var expSeconds)
            || DateTimeOffset.FromUnixTimeSeconds(expSeconds) < now - TimeSpan.FromMinutes(1))
        {
            payload.Dispose();
            return null;
        }

        if (payload.RootElement.TryGetProperty("nbf", out var nbf)
            && nbf.TryGetInt64(out var nbfSeconds)
            && DateTimeOffset.FromUnixTimeSeconds(nbfSeconds) > now + TimeSpan.FromMinutes(1))
        {
            payload.Dispose();
            return null;
        }

        return payload;
    }

    private static async Task<bool> VerifySignatureAsync(
        HttpClient http,
        string jwksBaseUrl,
        string? kid,
        byte[] signedInput,
        byte[] signature,
        CancellationToken ct)
    {
        var keys = await GetKeysAsync(http, jwksBaseUrl, forceRefresh: false, ct);
        if (Verify(keys, kid, signedInput, signature)) return true;

        // Unknown kid or stale cache after a key rotation: one refetch, then no.
        keys = await GetKeysAsync(http, jwksBaseUrl, forceRefresh: true, ct);
        return Verify(keys, kid, signedInput, signature);
    }

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

    private static async Task<IReadOnlyList<JwksKey>> GetKeysAsync(
        HttpClient http,
        string jwksBaseUrl,
        bool forceRefresh,
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
                await http.GetByteArrayAsync($"{jwksBaseUrl}/.well-known/jwks.json", ct));

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

            Cache[jwksBaseUrl] = new CachedJwks(DateTimeOffset.UtcNow, keys);
            return keys;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException
                                      or KeyNotFoundException or FormatException)
        {
            // Unreachable or malformed JWKS: fall back to whatever was cached —
            // stale public keys still verify genuine tokens — else no keys, and
            // every token is rejected rather than trusted.
            return Cache.TryGetValue(jwksBaseUrl, out var stale) ? stale.Keys : [];
        }
    }
}
