# BeeDocs MCP server — Streamable HTTP transport (.NET).
#
# Deployed as a sidecar next to the API container (same pod), so it reaches
# BeeDocs over the pod loopback at http://localhost:8080.
# Build context is the repo root:
#   podman build -f src/BeeDocs.Mcp/Dockerfile .

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY src/BeeDocs.Mcp/BeeDocs.Mcp.csproj src/BeeDocs.Mcp/
RUN dotnet restore src/BeeDocs.Mcp/BeeDocs.Mcp.csproj
COPY src/BeeDocs.Mcp/ src/BeeDocs.Mcp/
# Restore again after COPY so publish never relies on host bin/obj assets.
RUN dotnet publish src/BeeDocs.Mcp/BeeDocs.Mcp.csproj -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
ENV ASPNETCORE_ENVIRONMENT=Production \
    MCP_TRANSPORT=http \
    MCP_HTTP_PORT=5090 \
    MCP_HTTP_HOST=0.0.0.0
COPY --from=build /app/publish .
USER $APP_UID
EXPOSE 5090
ENTRYPOINT ["dotnet", "BeeDocs.Mcp.dll"]
