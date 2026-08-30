using System.Text.Json;
using System.Text.RegularExpressions;
using BeeDocs.Api.Models;

namespace BeeDocs.Api.Services;

/// <summary>Where the instance's custom logo file lives (a sibling of the SQLite/uploads dirs).</summary>
public sealed record BrandingOptions(string Root);

/// <summary>
/// Instance re-branding: a custom title in place of "BeeDocs" and a custom logo
/// in place of the 🐝 mark. Both are readable anonymously (the login screen shows
/// them before there is a session) and writable only by admins via
/// /api/settings/branding. The title lives in <c>app_setting</c>
/// (RbaSettingsService-style, cached); the logo is a single file under
/// <see cref="BrandingOptions.Root"/> rather than a row, because an uploaded PNG
/// is bytes, not text — the row only remembers the file name and a version
/// counter that cache-busts the logo URL.
///
/// This service also reports the active Omarchy desktop theme when the API runs
/// on a machine with Omarchy installed, so the web app can offer a theme that
/// follows the desktop. Only raw palette values cross the wire — deriving the
/// full token set is the client's job, next to the other themes.
/// </summary>
public sealed class BrandingService(SqliteConnectionFactory db, BrandingOptions options, ILlmClient llm)
{
    public const string DefaultTitle = "BeeDocs";

    private const string SettingKey = "branding.settings";
    private const int MaxTitleLength = 60;
    private const long MaxLogoBytes = 2 * 1024 * 1024;
    private const int MaxSvgChars = 512 * 1024;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static readonly IReadOnlyDictionary<string, string> LogoTypes =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [".svg"] = "image/svg+xml",
            [".png"] = "image/png",
            [".jpg"] = "image/jpeg",
            [".jpeg"] = "image/jpeg",
            [".webp"] = "image/webp",
        };

    private sealed record BrandingSettings(string? Title, string? LogoFile, long LogoVersion);

    // Same caching shape as RbaSettingsService: null = not read yet, a holder
    // caches "read, and this is what was stored" including nothing-stored.
    private volatile StoredHolder? _stored;

    private sealed record StoredHolder(BrandingSettings? Value);

    // The Omarchy files change when the user switches desktop theme, which is
    // rare — a short TTL keeps /api/branding from stat-ing files per request
    // while still following a switch within seconds.
    private readonly object _omarchyLock = new();
    private OmarchyThemeDto? _omarchyCached;
    private DateTimeOffset _omarchyReadAt = DateTimeOffset.MinValue;

    public async Task<BrandingDto> GetBrandingAsync(CancellationToken ct = default)
    {
        var stored = await GetStoredAsync(ct);
        var title = string.IsNullOrWhiteSpace(stored?.Title) ? DefaultTitle : stored!.Title!;
        var logoUrl = stored?.LogoFile is { Length: > 0 } file && File.Exists(Path.Combine(options.Root, file))
            ? $"/api/branding/logo?v={stored.LogoVersion}"
            : null;
        return new BrandingDto(title, stored?.Title is { Length: > 0 }, logoUrl, ReadOmarchyTheme());
    }

    /// <summary>Null or blank resets the title to the default.</summary>
    /// <exception cref="ArgumentException">Title longer than the header can hold.</exception>
    public async Task<BrandingDto> SetTitleAsync(string? title, CancellationToken ct = default)
    {
        var trimmed = (title ?? string.Empty).Trim();
        if (trimmed.Length > MaxTitleLength)
            throw new ArgumentException($"The title must be {MaxTitleLength} characters or fewer.");

        var stored = await GetStoredAsync(ct) ?? new BrandingSettings(null, null, 0);
        await SaveAsync(stored with { Title = trimmed.Length == 0 ? null : trimmed }, ct);
        return await GetBrandingAsync(ct);
    }

    /// <summary>An uploaded logo image. SVGs are sanitized like generated ones.</summary>
    /// <exception cref="ArgumentException">Wrong type, too large, or an unsafe SVG.</exception>
    public async Task<BrandingDto> SetLogoAsync(Stream content, long length, string fileName, CancellationToken ct = default)
    {
        var ext = Path.GetExtension(fileName);
        if (string.IsNullOrEmpty(ext) || !LogoTypes.ContainsKey(ext))
            throw new ArgumentException("The logo must be an SVG, PNG, JPEG, or WebP file.");
        if (length > MaxLogoBytes)
            throw new ArgumentException($"The logo exceeds the maximum size of {MaxLogoBytes / (1024 * 1024)} MB.");

        ext = ext.ToLowerInvariant();
        if (ext == ".svg")
        {
            using var reader = new StreamReader(content);
            var svg = await reader.ReadToEndAsync(ct);
            return await SetLogoSvgAsync(svg, ct);
        }

        var bytes = new MemoryStream();
        await content.CopyToAsync(bytes, ct);
        return await WriteLogoAsync("logo" + ext, bytes.ToArray(), ct);
    }

    /// <summary>A generated (or pasted) SVG logo, validated before it is served to everyone.</summary>
    /// <exception cref="ArgumentException">Not a lone &lt;svg&gt; element, or unsafe content.</exception>
    public async Task<BrandingDto> SetLogoSvgAsync(string svg, CancellationToken ct = default)
    {
        var clean = SanitizeSvg(svg);
        return await WriteLogoAsync("logo.svg", System.Text.Encoding.UTF8.GetBytes(clean), ct);
    }

    public async Task<BrandingDto> ClearLogoAsync(CancellationToken ct = default)
    {
        DeleteLogoFiles();
        var stored = await GetStoredAsync(ct);
        if (stored is not null)
            await SaveAsync(stored with { LogoFile = null }, ct);
        return await GetBrandingAsync(ct);
    }

    public async Task<(string Path, string ContentType)?> GetLogoAsync(CancellationToken ct = default)
    {
        var stored = await GetStoredAsync(ct);
        if (stored?.LogoFile is not { Length: > 0 } file) return null;
        var path = Path.Combine(options.Root, file);
        if (!File.Exists(path)) return null;
        return (path, LogoTypes.GetValueOrDefault(Path.GetExtension(file), "application/octet-stream"));
    }

    /// <summary>
    /// Draft a logo through the configured LLM provider. Returns the sanitized
    /// SVG for preview only — nothing is stored until the admin applies it via
    /// <see cref="SetLogoSvgAsync"/>, the same review gate the git AI actions use.
    /// </summary>
    /// <exception cref="LlmException">No provider, provider failure, or unusable output.</exception>
    public async Task<GenerateLogoResultDto> GenerateLogoAsync(GenerateLogoRequest request, CancellationToken ct = default)
    {
        var stored = await GetStoredAsync(ct);
        var title = string.IsNullOrWhiteSpace(stored?.Title) ? DefaultTitle : stored!.Title!;

        LlmCompleteResponse completion;
        try
        {
            completion = await llm.CompleteAsync(new LlmCompleteRequest(
                Task: LlmPrompts.Logo,
                Prompt: string.IsNullOrWhiteSpace(request.Prompt)
                    ? "A simple, friendly mark for a documentation platform."
                    : request.Prompt!,
                Context: title,
                Selection: null,
                ProviderId: request.ProviderId,
                Model: request.Model,
                MaxTokens: null,
                Temperature: null), ct);
        }
        catch (KeyNotFoundException e)
        {
            throw new LlmException(e.Message);
        }

        string svg;
        try
        {
            svg = SanitizeSvg(completion.Text);
        }
        catch (ArgumentException e)
        {
            throw new LlmException($"The model did not return a usable logo: {e.Message}");
        }

        return new GenerateLogoResultDto(
            Svg: svg,
            ProviderName: completion.ProviderName,
            Model: completion.Model,
            ElapsedMs: completion.ElapsedMs);
    }

    /// <summary>
    /// The logo is served anonymously to every visitor, and the generated path
    /// is model output — so a lone &lt;svg&gt; element with no scripting is the
    /// contract, enforced here rather than trusted from either source.
    /// </summary>
    private static string SanitizeSvg(string raw)
    {
        var text = raw ?? string.Empty;
        var start = text.IndexOf("<svg", StringComparison.OrdinalIgnoreCase);
        var end = text.LastIndexOf("</svg>", StringComparison.OrdinalIgnoreCase);
        if (start < 0 || end < start)
            throw new ArgumentException("Expected a single <svg> element.");

        text = text[start..(end + "</svg>".Length)];
        if (text.Length > MaxSvgChars)
            throw new ArgumentException("The SVG is larger than 512 KB.");

        foreach (var banned in new[] { "<script", "<foreignobject", "<iframe", "<embed", "<object", "<image", "javascript:", "url(http", "@import" })
        {
            if (text.Contains(banned, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException($"The SVG contains disallowed content ({banned.TrimStart('<')}).");
        }

        // Event handlers and references that leave the document.
        if (Regex.IsMatch(text, @"\son\w+\s*=", RegexOptions.IgnoreCase))
            throw new ArgumentException("The SVG contains event handler attributes.");
        if (Regex.IsMatch(text, "href\\s*=\\s*[\"'](?!#)", RegexOptions.IgnoreCase))
            throw new ArgumentException("The SVG references content outside the document.");

        return text;
    }

    private async Task<BrandingDto> WriteLogoAsync(string fileName, byte[] bytes, CancellationToken ct)
    {
        Directory.CreateDirectory(options.Root);
        DeleteLogoFiles(keep: fileName);
        await File.WriteAllBytesAsync(Path.Combine(options.Root, fileName), bytes, ct);

        var stored = await GetStoredAsync(ct) ?? new BrandingSettings(null, null, 0);
        await SaveAsync(stored with { LogoFile = fileName, LogoVersion = stored.LogoVersion + 1 }, ct);
        return await GetBrandingAsync(ct);
    }

    /// <summary>One logo at a time: replacing a PNG with an SVG must not leave the PNG behind.</summary>
    private void DeleteLogoFiles(string? keep = null)
    {
        if (!Directory.Exists(options.Root)) return;
        foreach (var path in Directory.EnumerateFiles(options.Root, "logo.*"))
        {
            if (keep is not null && Path.GetFileName(path).Equals(keep, StringComparison.OrdinalIgnoreCase))
                continue;
            try { File.Delete(path); } catch (IOException) { /* a locked leftover only wastes bytes */ }
        }
    }

    private async Task SaveAsync(BrandingSettings settings, CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO app_setting (key, value, updated_at)
            VALUES ($key, $value, $updated_at)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """;
        SqliteHelpers.Add(cmd, "$key", SettingKey);
        SqliteHelpers.Add(cmd, "$value", JsonSerializer.Serialize(settings, Json));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync(ct);

        _stored = new StoredHolder(settings);
    }

    private async Task<BrandingSettings?> GetStoredAsync(CancellationToken ct)
    {
        if (_stored is { } cached) return cached.Value;

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT value FROM app_setting WHERE key = $key LIMIT 1";
        SqliteHelpers.Add(cmd, "$key", SettingKey);
        var raw = await cmd.ExecuteScalarAsync(ct) as string;

        BrandingSettings? value = null;
        if (!string.IsNullOrWhiteSpace(raw))
        {
            try
            {
                value = JsonSerializer.Deserialize<BrandingSettings>(raw, Json);
            }
            catch (JsonException)
            {
                // A corrupt row must not take the header down with it.
            }
        }

        _stored = new StoredHolder(value);
        return value;
    }

    // ----- Omarchy desktop theme -----

    private OmarchyThemeDto? ReadOmarchyTheme()
    {
        lock (_omarchyLock)
        {
            var now = DateTimeOffset.UtcNow;
            if (now - _omarchyReadAt < TimeSpan.FromSeconds(5)) return _omarchyCached;
            _omarchyReadAt = now;
            _omarchyCached = ReadOmarchyThemeUncached();
            return _omarchyCached;
        }
    }

    private static OmarchyThemeDto? ReadOmarchyThemeUncached()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.IsNullOrEmpty(home)) return null;

        // Current Omarchy keeps live state under ~/.local/state; older releases
        // symlinked the theme under ~/.config. Check both, newest first.
        foreach (var current in new[]
        {
            Path.Combine(home, ".local", "state", "omarchy", "current"),
            Path.Combine(home, ".config", "omarchy", "current"),
        })
        {
            var themeDir = Path.Combine(current, "theme");
            if (!Directory.Exists(themeDir)) continue;
            try
            {
                var theme = ReadThemeDir(current, themeDir);
                if (theme is not null) return theme;
            }
            catch (IOException) { /* a half-switched theme is a miss, not an error */ }
            catch (UnauthorizedAccessException) { }
        }

        return null;
    }

    private static OmarchyThemeDto? ReadThemeDir(string currentDir, string themeDir)
    {
        var name = ReadThemeName(currentDir, themeDir);

        // colors.toml is Omarchy's canonical palette (mode, accent, background
        // shades). Themes without one still ship alacritty.toml, whose
        // [colors.primary]/[colors.normal] sections carry enough to derive from.
        var colors = ParseTomlColors(Path.Combine(themeDir, "colors.toml"), section: null);
        string? scheme = null;
        if (colors.TryGetValue("mode", out var mode) && (mode == "light" || mode == "dark"))
            scheme = mode;

        var background = Hex(colors.GetValueOrDefault("background"));
        var foreground = Hex(colors.GetValueOrDefault("foreground"));

        if (background is null || foreground is null)
        {
            var primary = ParseTomlColors(Path.Combine(themeDir, "alacritty.toml"), "colors.primary");
            var normal = ParseTomlColors(Path.Combine(themeDir, "alacritty.toml"), "colors.normal");
            background = Hex(primary.GetValueOrDefault("background"));
            foreground = Hex(primary.GetValueOrDefault("foreground"));
            if (background is null || foreground is null) return null;
            foreach (var (key, value) in normal)
                colors.TryAdd(key, value);
        }

        scheme ??= File.Exists(Path.Combine(themeDir, "light.mode")) ? "light" : "dark";

        return new OmarchyThemeDto(
            Name: name,
            Scheme: scheme,
            Background: background,
            Foreground: foreground,
            Accent: Hex(colors.GetValueOrDefault("accent")),
            Muted: Hex(colors.GetValueOrDefault("light_foreground")) ?? Hex(colors.GetValueOrDefault("muted")),
            BgLighter: Hex(colors.GetValueOrDefault("lighter_background")),
            BgDarker: Hex(colors.GetValueOrDefault("dark_background")),
            Selection: Hex(colors.GetValueOrDefault("selection")),
            Red: Hex(colors.GetValueOrDefault("red")),
            Green: Hex(colors.GetValueOrDefault("green")),
            Yellow: Hex(colors.GetValueOrDefault("yellow")),
            Blue: Hex(colors.GetValueOrDefault("blue")),
            Magenta: Hex(colors.GetValueOrDefault("magenta")),
            Cyan: Hex(colors.GetValueOrDefault("cyan")));
    }

    private static string ReadThemeName(string currentDir, string themeDir)
    {
        var nameFile = Path.Combine(currentDir, "theme.name");
        if (File.Exists(nameFile))
        {
            var name = File.ReadAllText(nameFile).Trim();
            if (name.Length > 0) return name;
        }

        var target = new DirectoryInfo(themeDir).ResolveLinkTarget(returnFinalTarget: true);
        return Path.GetFileName((target?.FullName ?? themeDir).TrimEnd('/'));
    }

    /// <summary>
    /// The two Omarchy files are flat `key = "value"` TOML — a full parser would
    /// be a dependency for eight lines of shape. <paramref name="section"/> null
    /// reads top-level keys; otherwise only keys inside that [section].
    /// </summary>
    private static Dictionary<string, string> ParseTomlColors(string path, string? section)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!File.Exists(path)) return result;

        string? currentSection = null;
        foreach (var rawLine in File.ReadLines(path))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;

            if (line.StartsWith('[') && line.EndsWith(']'))
            {
                currentSection = line[1..^1].Trim();
                continue;
            }

            if (currentSection != section) continue;

            var eq = line.IndexOf('=');
            if (eq <= 0) continue;
            var key = line[..eq].Trim();
            var value = line[(eq + 1)..].Trim().Trim('"', '\'');
            if (key.Length > 0 && value.Length > 0)
                result[key] = value;
        }

        return result;
    }

    /// <summary>Normalize `#rrggbb` / `0xrrggbb` / `#rgb`; anything else is dropped.</summary>
    private static string? Hex(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var v = value.Trim();
        if (v.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) v = "#" + v[2..];
        if (!v.StartsWith('#')) v = "#" + v;
        if (Regex.IsMatch(v, "^#[0-9a-fA-F]{6}$")) return v.ToLowerInvariant();
        if (Regex.IsMatch(v, "^#[0-9a-fA-F]{3}$"))
            return $"#{v[1]}{v[1]}{v[2]}{v[2]}{v[3]}{v[3]}".ToLowerInvariant();
        return null;
    }
}
