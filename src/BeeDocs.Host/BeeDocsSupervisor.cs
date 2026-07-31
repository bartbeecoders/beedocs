using System.Diagnostics;
using Microsoft.Extensions.Options;

namespace BeeDocs.Host;

public sealed class BeeDocsSupervisor(
    IOptions<BeeDocsHostOptions> options,
    IHostEnvironment environment,
    ILogger<BeeDocsSupervisor> logger) : BackgroundService
{
    private readonly BeeDocsHostOptions _options = options.Value;
    private Process? _apiProcess;
    private Process? _mcpProcess;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var contentRoot = environment.ContentRootPath;
        var dataRoot = Path.GetFullPath(_options.DataDirectory, contentRoot);
        var logsRoot = Path.GetFullPath(_options.LogsDirectory, contentRoot);
        Directory.CreateDirectory(Path.Combine(dataRoot, "sqlite"));
        Directory.CreateDirectory(Path.Combine(dataRoot, "uploads"));
        Directory.CreateDirectory(logsRoot);

        var apiDir = Path.GetFullPath(_options.ApiDirectory, contentRoot);
        var mcpDir = Path.GetFullPath(_options.McpDirectory, contentRoot);
        var apiDll = Path.Combine(apiDir, "BeeDocs.Api.dll");
        var mcpEntry = Path.Combine(mcpDir, "dist", "index.js");

        ValidateLayout(apiDll, mcpEntry);

        var uiPathBase = BeeDocsHostOptions.NormalizePathBase(_options.UiPathBase);
        var apiPathBase = BeeDocsHostOptions.NormalizePathBase(_options.ApiPathBase);
        if (apiPathBase.Length == 0)
        {
            apiPathBase = uiPathBase;
        }

        var mcpPathBase = BeeDocsHostOptions.NormalizePathBase(_options.McpPathBase);
        var apiUrl = $"http://127.0.0.1:{_options.ApiPort}";
        var uiUrl = $"http://127.0.0.1:{_options.UiPort}";
        // Backend always listens at root — ReverseProxy strip_prefix removes the public path.
        var apiHealthUrl = $"{apiUrl}/api/health";
        var mcpHealthUrl = $"http://127.0.0.1:{_options.McpPort}/healthz";

        logger.LogInformation("BeeDocs host starting (content root: {Root})", contentRoot);
        if (_options.UiPort == _options.ApiPort)
        {
            logger.LogInformation("  Upstream UI+API: {Url}", apiUrl);
        }
        else
        {
            logger.LogInformation("  Upstream UI:  {UiUrl}", uiUrl);
            logger.LogInformation("  Upstream API: {ApiUrl}", apiUrl);
        }

        logger.LogInformation("  Upstream MCP: http://127.0.0.1:{McpPort}", _options.McpPort);
        if (uiPathBase.Length > 0 || apiPathBase.Length > 0 || mcpPathBase.Length > 0)
        {
            logger.LogInformation(
                "  Public (ReverseProxy): UI {UiPath} → :{UiPort}, API {ApiPath}/api → :{ApiPort}, MCP {McpPath}/mcp → :{McpPort}",
                uiPathBase.Length == 0 ? "/" : uiPathBase,
                _options.UiPort,
                apiPathBase.Length == 0 ? "" : apiPathBase,
                _options.ApiPort,
                mcpPathBase.Length == 0 ? "" : mcpPathBase,
                _options.McpPort);
        }

        _apiProcess = StartDotNet(
            apiDir,
            apiDll,
            Path.Combine(logsRoot, "api.log"),
            new Dictionary<string, string?>
            {
                ["ASPNETCORE_ENVIRONMENT"] = "Production",
                ["ASPNETCORE_URLS"] = _options.BuildAspNetCoreUrls(),
                ["BeeDocs__DataPath"] = Path.Combine(dataRoot, "sqlite"),
                ["BeeDocs__UploadsPath"] = Path.Combine(dataRoot, "uploads"),
            });

        await WaitForHttpAsync(apiHealthUrl, "API", stoppingToken);

        _mcpProcess = StartNode(
            mcpDir,
            mcpEntry,
            Path.Combine(logsRoot, "mcp.log"),
            new Dictionary<string, string?>
            {
                ["MCP_TRANSPORT"] = "http",
                ["MCP_HTTP_HOST"] = _options.McpBindHost,
                ["MCP_HTTP_PORT"] = _options.McpPort.ToString(),
                ["MCP_AUTH_TOKEN"] = _options.McpAuthToken,
                ["BEEDOCS_API_URL"] = apiUrl,
            });

        await WaitForHttpAsync(mcpHealthUrl, "MCP", stoppingToken);

        logger.LogInformation("BeeDocs is ready.");
        if (_options.UiPort == _options.ApiPort)
        {
            logger.LogInformation("  Local UI+API: http://localhost:{Port}", _options.ApiPort);
        }
        else
        {
            logger.LogInformation("  Local UI:  http://localhost:{UiPort}", _options.UiPort);
            logger.LogInformation("  Local API: http://localhost:{ApiPort}/api", _options.ApiPort);
        }

        logger.LogInformation("  Local MCP: http://localhost:{McpPort}/mcp", _options.McpPort);

        while (!stoppingToken.IsCancellationRequested)
        {
            EnsureRunning(_apiProcess, "API");
            EnsureRunning(_mcpProcess, "MCP");
            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        logger.LogInformation("Stopping BeeDocs child processes...");
        await StopProcessAsync(_mcpProcess);
        await StopProcessAsync(_apiProcess);
        await base.StopAsync(cancellationToken);
    }

    private void ValidateLayout(string apiDll, string mcpEntry)
    {
        if (!File.Exists(apiDll))
        {
            throw new FileNotFoundException(
                $"API not found at '{apiDll}'. Run scripts/publish-windows.ps1 to build a deployable folder.",
                apiDll);
        }

        if (!File.Exists(mcpEntry))
        {
            throw new FileNotFoundException(
                $"MCP entry not found at '{mcpEntry}'. Run scripts/publish-windows.ps1 to build a deployable folder.",
                mcpEntry);
        }
    }

    private void EnsureRunning(Process? process, string name)
    {
        if (process is { HasExited: true })
        {
            throw new InvalidOperationException($"{name} exited unexpectedly (code {process.ExitCode}).");
        }
    }

    private Process StartDotNet(
        string workingDirectory,
        string dllPath,
        string logPath,
        IReadOnlyDictionary<string, string?> environment)
    {
        logger.LogInformation("Starting API ({Dll})", dllPath);
        return StartProcess(
            "dotnet",
            $"\"{dllPath}\"",
            workingDirectory,
            logPath,
            environment);
    }

    private Process StartNode(
        string workingDirectory,
        string scriptPath,
        string logPath,
        IReadOnlyDictionary<string, string?> environment)
    {
        logger.LogInformation("Starting MCP ({Script})", scriptPath);
        return StartProcess(
            _options.NodeExecutable,
            $"\"{scriptPath}\"",
            workingDirectory,
            logPath,
            environment);
    }

    private Process StartProcess(
        string fileName,
        string arguments,
        string workingDirectory,
        string logPath,
        IReadOnlyDictionary<string, string?> environment)
    {
        var logStream = new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.Read);
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };

        foreach (var (key, value) in environment)
        {
            if (value is not null)
            {
                startInfo.Environment[key] = value;
            }
        }

        var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => WriteLogLine(logStream, e.Data);
        process.ErrorDataReceived += (_, e) => WriteLogLine(logStream, e.Data);
        process.Exited += (_, _) => logStream.Dispose();

        if (!process.Start())
        {
            logStream.Dispose();
            throw new InvalidOperationException($"Failed to start process: {fileName} {arguments}");
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private static void WriteLogLine(FileStream logStream, string? line)
    {
        if (string.IsNullOrEmpty(line))
        {
            return;
        }

        var bytes = System.Text.Encoding.UTF8.GetBytes(line + Environment.NewLine);
        logStream.Write(bytes, 0, bytes.Length);
        logStream.Flush();
    }

    private async Task WaitForHttpAsync(string url, string name, CancellationToken cancellationToken)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        var deadline = DateTimeOffset.UtcNow.AddSeconds(_options.HealthTimeoutSeconds);

        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                using var response = await client.GetAsync(url, cancellationToken);
                if (response.IsSuccessStatusCode)
                {
                    logger.LogInformation("{Name} is ready at {Url}", name, url);
                    return;
                }
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
            {
                // Expected while the child process is still binding its port.
            }

            await Task.Delay(250, cancellationToken);
        }

        throw new TimeoutException($"{name} did not become ready at {url} within {_options.HealthTimeoutSeconds}s.");
    }

    private async Task StopProcessAsync(Process? process)
    {
        if (process is null || process.HasExited)
        {
            return;
        }

        try
        {
            if (OperatingSystem.IsWindows())
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "taskkill",
                    Arguments = $"/T /F /PID {process.Id}",
                    CreateNoWindow = true,
                    UseShellExecute = false,
                })?.WaitForExit(5000);
            }
            else
            {
                process.Kill(entireProcessTree: true);
            }

            await process.WaitForExitAsync();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to stop process {Pid}", process.Id);
        }
    }
}
