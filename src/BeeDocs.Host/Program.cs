using BeeDocs.Host;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.Configure<BeeDocsHostOptions>(
    builder.Configuration.GetSection(BeeDocsHostOptions.SectionName));
builder.Services.AddWindowsService(options => options.ServiceName = "BeeDocs");
builder.Services.AddHostedService<BeeDocsSupervisor>();

var host = builder.Build();
host.Run();
