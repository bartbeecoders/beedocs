Build a app that helps me create technical documentation for my software development team.



Build (or iteratively vibe-code) a **simple, self-hosted documentation platform** optimized for **software + hardware systems architecture documentation**.  

**Core requirements:**  
- **Structure**: Books/Shelves → Chapters → Pages (like BookStack) or flexible wiki hierarchy. Support rich text (WYSIWYG + Markdown toggle).  
- **Architecture focus**: Built-in support for C4 model diagrams (Context, Containers, Components, Code). Easy embedding of PlantUML, Mermaid, or diagrams.net-style diagrams.  
- **Hardware support**: Sections for device inventories, network topologies, rack diagrams, BOMs, and configuration matrices.  
- **Key features**:  
  - Full-text search across all content.  
  - Version history & diffs on pages.  
  - Role-based permissions (public read, team edit, admin).  
  - Image/diagram upload + gallery.  
  - Export to PDF/Markdown/HTML.  
  - Git sync option (optional but nice).  
  - Dark mode, responsive, mobile-friendly.  
- **Tech stack preferences** (keep it lightweight and open-source friendly):  
  - Backend: dotnet 10 c#.  
  - DB: SurrealDB (embedded version)
  - Frontend: React/Vite 
  - Container: Docker/podman-ready.  
  - pnpm as package manager
- **Vibe**: Clean, fast, delightful UX like BookStack. Minimal bloat. Focus on "documentation as code" where possible.  

- Integrate a self made diagram editor

**Output format (step-by-step vibe coding mode):**  
1. **High-level architecture** (C4-style text description or simple diagram in Mermaid).  
2. **Folder/project structure**.  
3. **Core models/entities** (Page, Book, Diagram, etc.).  
4. **Key files to implement first** (with starter code snippets).  
5. **Next steps / iteration prompts** for me to expand (e.g., "now add diagram embedding").  

Start with the MVP: basic CRUD for Books/Pages + Markdown editor + Mermaid support. Make it extensible.  

Project name: BeeDocs




Refactor the UI
- make it more professional
- focus everything on 1 page
    - header section
    - left pane with folders/books/pages tree
    - middle canvas with the page in edit mode
    - right pane with properties
- panes sshould be adjustable, collapsable
- add a settings page
- add color themes



Use the beedocs mcp to create a book with pages describing in detail, with Beediagrams and descriptions the project in this folder:
/run/media/bart/Development/dev/bartbeecoders/InSyncBee

Make it technical.