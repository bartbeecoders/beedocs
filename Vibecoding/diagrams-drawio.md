Add to the diagram module a more draw.io like mode.

Try to replicate the same UI/ way of creating diagrams (see https://app.diagrams.net/)

In the diagram, container object, allow other shapes to be put into the container.


In the diagram (studio) designer, some objects have multiple parts, allow for the user to give them different colors.
→ Done: style.fill / style.fill2, Format panel part labels, multi-part rendering for
  container, cube, note, cylinder (+ classic database/note).

  In the diagram (studio) designer, allow for a colection of objects to be saved as a collection, so that the user can use that collection from the object picker.
  User should be able to give it a name and description.
  These collection items should be saved in the book.
→ Done: shape_collection table + API, Studio save dialog / palette group,
  archive export-import, delete with book.
→ Done: scope choice — book-level or app-wide library (GET/POST /api/collections).

  Add the option to save the collection item at book level or at overall app level.