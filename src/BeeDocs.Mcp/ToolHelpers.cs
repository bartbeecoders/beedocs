using System.Text.Json;
using ModelContextProtocol;

namespace BeeDocs.Mcp;

internal static class ToolHelpers
{
    public const string EmptyBeeDiagram =
        """{"version":1,"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}""";

    public const string EmptyIsometric =
        """{"version":1,"items":[],"connectors":[],"zones":[],"texts":[],"viewport":{"x":0,"y":0,"zoom":1}}""";

    public static string Json(object value) => BeeDocsApiClient.Pretty(value);

    public static string Json(JsonElement value) => BeeDocsApiClient.Pretty(value);

    /// <summary>Rethrow API/tool failures as MCP tool errors with the original message.</summary>
    public static Exception AsToolError(Exception ex) =>
        ex switch
        {
            McpException mcp => mcp,
            BeeDocsApiException api => new McpException(api.Message),
            _ => new McpException(ex.Message),
        };

    public static async Task<string> RunAsync(Func<Task<string>> action)
    {
        try
        {
            return await action();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            throw AsToolError(ex);
        }
    }
}
