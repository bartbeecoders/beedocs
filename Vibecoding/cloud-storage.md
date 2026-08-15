Allow for bookshelves to be stored in the cloud (instead of the sqlite db)

Add storage providers that can be configured in the settings:
- sqlite db (current way of storing)
- azure storage account (blob storage)
- google drive
- other providers can be added later

The user can then set the storage provider for a boolshelf. This would move all books, pages, diagrams etc from that bookshelf to that storage provider.