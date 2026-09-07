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


The RBA integration still gives issues, does not work.
The RBA endpoint is configured as https://bebomesservice/alpharbaservice  
application code doc
From the client side, this endpoint works (using it on other apps)

error I get: 
index-dR2EOBgV.js:76  POST https://bebomesservice/beedocs-api/api/auth/rba 401 (Unauthorized)

https://beboappt3/alpharbaservice/.well-known/jwks.json

I switched the RBA endpoiunt to https://bebomesservice/alpharbaservice 
But I think what the problem is, remember that the beedocs site and api are actually running in azure, RBA is running on prem. On the beedocs site we connect to rba client side, but from the api you cannot connect to rba. I also wander why this is needed ?



### Shelf/book/documents private
Add to abiity for a user (owner of the item), to set the item private. When an item is private, only the owner can see it.