# --- API ---
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS api-build
WORKDIR /src
COPY src/BeeDocs.Api/BeeDocs.Api.csproj src/BeeDocs.Api/
RUN dotnet restore src/BeeDocs.Api/BeeDocs.Api.csproj
COPY src/BeeDocs.Api/ src/BeeDocs.Api/
RUN dotnet publish src/BeeDocs.Api/BeeDocs.Api.csproj -c Release -o /app/api /p:UseAppHost=false

# --- Web ---
FROM node:22-bookworm AS web-build
WORKDIR /web
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY src/beedocs-web/package.json src/beedocs-web/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY src/beedocs-web/ ./
RUN pnpm build

# --- Runtime ---
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY --from=api-build /app/api ./
COPY --from=web-build /web/dist ./wwwroot
ENV ASPNETCORE_URLS=http://+:8080
ENV BeeDocs__DataPath=/data/surreal
ENV BeeDocs__UploadsPath=/data/uploads
ENV ConnectionStrings__SurrealDB=Endpoint=rocksdb:///data/surreal
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["dotnet", "BeeDocs.Api.dll"]
