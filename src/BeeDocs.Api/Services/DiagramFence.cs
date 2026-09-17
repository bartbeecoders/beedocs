using System.Security.Cryptography;
using System.Text;

namespace BeeDocs.Api.Services;

/// <summary>
/// One diagram fence a DOCX export would like rendered as a picture.
/// </summary>
/// <param name="Key">Stable id for the fence, derived from its language and text (see <see cref="DiagramFence.KeyFor"/>).</param>
/// <param name="Kind">Renderer to use: <c>mermaid</c>, <c>beediagram</c>, <c>isometric</c> or <c>freedraw</c>.</param>
/// <param name="Source">The diagram source — for <c>-ref</c> fences, the stored diagram's body, not the id.</param>
/// <param name="Title">Caption, when the fence points at a titled diagram.</param>
public sealed record DiagramFenceDto(string Key, string Kind, string Source, string? Title);

/// <summary>
/// The contract between the API and the browser for DOCX diagram pictures.
///
/// The API cannot rasterise a diagram (that needs a DOM), so it publishes the
/// fences an export contains, the browser draws each one to a PNG and posts
/// them back, and the writer embeds whichever it receives. The fence key is
/// computed from the fence itself on both trips, so a page edited between the
/// two calls simply gets the source-block fallback for the changed fence
/// rather than a stale picture.
/// </summary>
public static class DiagramFence
{
    /// <summary>Fence languages that have a browser renderer.</summary>
    public static bool IsRenderable(string language) => language is
        "mermaid" or "c4"
        or "beediagram" or "beediagram-ref"
        or "isometric" or "isometric-ref"
        or "freedraw" or "sketch";

    public static bool IsReference(string language) => language.EndsWith("-ref", StringComparison.Ordinal);

    /// <summary>The diagram id a <c>-ref</c> fence names: its first token.</summary>
    public static string ReferencedId(string text) =>
        text.Trim().Split((char[])[' ', '\t', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? string.Empty;

    /// <summary>
    /// Key for a fence as <see cref="MarkdownDoc.Parse"/> produces it: the
    /// lowercased language and the body with line endings normalised and the
    /// trailing newline removed. Both the manifest and the writer go through
    /// this one method, so they cannot disagree.
    /// </summary>
    public static string KeyFor(string language, string text)
    {
        var normalised = language.ToLowerInvariant() + "\n" + text.Replace("\r\n", "\n").TrimEnd('\n');
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(normalised));
        return Convert.ToHexStringLower(hash.AsSpan(0, 16));
    }

    /// <summary>Renderer for a fence: the stored diagram's kind wins for references.</summary>
    public static string RendererFor(string language, string? diagramKind) => language switch
    {
        "c4" => "mermaid",
        "sketch" => "freedraw",
        "beediagram-ref" or "isometric-ref" => diagramKind switch
        {
            "isometric" => "isometric",
            "mermaid" or "c4" => "mermaid",
            _ => language == "isometric-ref" ? "isometric" : "beediagram",
        },
        _ => language,
    };
}
