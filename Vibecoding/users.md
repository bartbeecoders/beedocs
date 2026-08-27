Add the capability for user management and roles

- simple user/role based managment
- store the user accounts into the database
- encrypt the passwords
- add a default admin account (seed with random password at 1st run)


Add a book owner field
Add a page owner field (defaults from book)
Keep on each page a history table, date/time changed, user who changed it


Add a seperate users management page.
Only admins can manage users.



RBA Integration
Add the RBA integration. The RBA service can be used to handle the authentication and autorization (code is at: F:\capdev\alpha\rba\api_backend)
Define tha Application in RBA as DOC.
Define a list of groups and actions we need to create.
Create me a complete sql data creation script to add the needed record to the RBA database.