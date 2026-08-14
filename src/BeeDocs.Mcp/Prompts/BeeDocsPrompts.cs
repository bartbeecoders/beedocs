using System.ComponentModel;
using Microsoft.Extensions.AI;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Prompts;

[McpServerPromptType]
public sealed class BeeDocsPrompts
{
    [McpServerPrompt(Name = "beedocs_document_system", Title = "Document a software system"),
     Description("Guide for creating a book, architecture pages, and C4/BeeDiagrams for a named system.")]
    public static ChatMessage DocumentSystem(
        [Description("Name of the system to document")] string systemName,
        [Description("Optional domain/context notes for the agent")] string? context = null)
    {
        var text = string.Join('\n',
            $"Document the software system \"{systemName}\" in BeeDocs using MCP tools.",
            "",
            "Steps:",
            "1. Call beedocs_health to verify the API.",
            "2. beedocs_list_books — reuse a matching book or beedocs_create_book.",
            "3. Create pages with beedocs_create_page:",
            "   - System Context (C4 L1)",
            "   - Containers (C4 L2)",
            "   - Deployment / network notes",
            "4. Create diagrams with beedocs_create_beediagram_with_nodes or beedocs_create_diagram (kind mermaid/c4).",
            "5. Embed diagrams into pages with beedocs_embed_diagram_in_page.",
            "6. Prefer clear Markdown headings, bullet lists, and Mermaid where helpful.",
            string.IsNullOrEmpty(context) ? "" : $"\nAdditional context:\n{context}");
        return new ChatMessage(ChatRole.User, text);
    }

    [McpServerPrompt(Name = "beedocs_add_architecture_diagram", Title = "Add architecture diagram"),
     Description("Create a BeeDiagram and embed it into an existing page.")]
    public static ChatMessage AddArchitectureDiagram(
        string bookId,
        string pageId,
        string diagramTitle,
        [Description("What the diagram should show (components, people, data flows)")] string description)
    {
        var text = string.Join('\n',
            $"Add architecture diagram \"{diagramTitle}\" to BeeDocs.",
            $"bookId={bookId}",
            $"pageId={pageId}",
            "",
            "1. beedocs_list_diagram_shapes to see the shape catalog. For a cloud diagram, filter it",
            "   (section=\"azure\", plus azureCategory or query) and use shape=\"azure\" + icon=\"<id>\" nodes —",
            "   aks, app-service, sql-database, table-storage, key-vault, … render as Azure service stencils.",
            "2. Group them with shape=\"container\" nodes (subscription / resource group / VNet / subnet) and",
            "   set parentId on each child so the boundary moves as one.",
            "3. beedocs_create_beediagram_with_nodes with labelled edges (route=\"orthogonal\" reads best for",
            "   infrastructure). Otherwise person/system/box/database nodes are fine for a C4-style view.",
            "4. beedocs_embed_diagram_in_page with a suitable heading.",
            "",
            "Diagram intent:",
            description);
        return new ChatMessage(ChatRole.User, text);
    }

    [McpServerPrompt(Name = "beedocs_create_presentation", Title = "Create a slide presentation"),
     Description("Create a PowerPoint-style slide deck in a book, optionally sourced from existing pages.")]
    public static ChatMessage CreatePresentation(
        string bookId,
        string deckTitle,
        [Description("What the presentation should cover (topics, audience, existing pages to draw from)")] string description)
    {
        var text = string.Join('\n',
            $"Create slide deck \"{deckTitle}\" in BeeDocs book {bookId}.",
            "",
            "1. If the deck should summarise existing content, read it first (beedocs_get_book_tree,",
            "   beedocs_get_page) so slides reflect what the book actually says.",
            "2. beedocs_create_slide_deck_with_slides with structured slides on a 1280×720 canvas:",
            "   a title slide, then one idea per slide — a heading (fontSize ~44, bold) plus a few",
            "   short bullet lines (fontSize ~24), not paragraphs. Put detail in each slide's notes.",
            "3. Shapes (rect/rounded/ellipse/arrow/…) make simple visuals; element order is z-order.",
            "   Images need an /uploads/… URL from beedocs_upload_image.",
            "4. Return the deck's workspace URL so the author can open the designer and present.",
            "",
            "Presentation intent:",
            description);
        return new ChatMessage(ChatRole.User, text);
    }

    [McpServerPrompt(Name = "beedocs_write_runbook_page", Title = "Write an ops runbook page"),
     Description("Create or update a runbook-style Markdown page in a book.")]
    public static ChatMessage WriteRunbookPage(string bookId, string topic)
    {
        var text = string.Join('\n',
            $"Create a runbook page for \"{topic}\" in book {bookId}.",
            "Use beedocs_create_page with sections: Overview, Prerequisites, Procedure, Verification, Rollback, Related systems.",
            "Use Markdown checklists for steps. Optionally add a simple mermaid sequence diagram.");
        return new ChatMessage(ChatRole.User, text);
    }
}
