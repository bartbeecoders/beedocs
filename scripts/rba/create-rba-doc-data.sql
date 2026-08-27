/* =============================================================================
   RBA data creation script for BeeDocs (application DOC)
   Target: Alpha database, schema [rba] — written against the LIVE structure
   (GUID keys with newsequentialid() defaults, datetimeoffset dates; the
   rba.action table has application_id only, no application_cd column).

   Creates:
     1. Application  DOC
     2. 20 actions   (DOC_* — unique per application: uk_altkey(application_id, name))
     3. 3 groups     (rba.role_plant: DOC_VIEWER / DOC_EDITOR / DOC_ADMIN,
                      unique per application + name + plant)
     4. role_action  links (viewer ⊂ editor ⊂ admin)

   The script is idempotent: every insert is guarded by NOT EXISTS, so it can
   be re-run safely (e.g. after adding a new action to the list).

   PLANTS: role_plant is unique on (application_id, name, plant_cd), so the same
   group name may exist on several plants. This script creates the three groups
   for @plant_cd; re-run with another value to add another plant.
   ========================================================================== */

USE [Alpha];
GO
-- Required by the filtered unique index UQ_role_action_active; SSMS sets these
-- by default but sqlcmd does not. Their own batch, because QUOTED_IDENTIFIER
-- applies at parse time of the *next* batch.
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRANSACTION;

DECLARE @modified_by nvarchar(100)  = N'RBA_SETUP_BEEDOCS';
DECLARE @plant_cd    nvarchar(20)   = N'BOR';           -- adjust to your plant code
DECLARE @app_owner   nvarchar(100)  = N'Bart Roelant';  -- application owner shown in RBA
DECLARE @now         datetimeoffset = SYSDATETIMEOFFSET();

/* ---------------------------------------------------------------------------
   1. Application: DOC
   ------------------------------------------------------------------------ */
DECLARE @app_id uniqueidentifier;

SELECT @app_id = id FROM rba.application WHERE application_cd = N'DOC';

IF @app_id IS NULL
BEGIN
    SET @app_id = NEWID();
    INSERT INTO rba.application
        (id, application_cd, description, requires_2fa, pin_validity_minutes,
         is_active, created_date, application_owner, modified_by)
    VALUES
        (@app_id, N'DOC', N'BeeDocs - documentation platform (books, pages, diagrams, slides)',
         0, NULL, 1, @now, @app_owner, @modified_by);
    PRINT 'Application DOC created.';
END
ELSE
    PRINT 'Application DOC already exists - reusing.';

/* ---------------------------------------------------------------------------
   2. Actions (rba.action — no application_cd column; application_id is the link)
   ------------------------------------------------------------------------ */
DECLARE @actions TABLE (name nvarchar(100) PRIMARY KEY, description nvarchar(100));

INSERT INTO @actions (name, description) VALUES
-- Read tier -------------------------------------------------------------
 (N'DOC_CONTENT_READ',            N'Read shelves, books, chapters, pages, diagrams and slide decks'),
 (N'DOC_SEARCH',                  N'Search the documentation library'),
 (N'DOC_ATTACHMENT_DOWNLOAD',     N'Download book attachments (PDF, Office, archives)'),
 (N'DOC_EXPORT',                  N'Export books/pages (PDF, DOCX) and slide decks (PPTX)'),
 (N'DOC_SLIDES_PRESENT',          N'Start full-screen slide presentations'),
-- Author tier -----------------------------------------------------------
 (N'DOC_BOOK_WRITE',              N'Create, edit and delete books'),
 (N'DOC_PAGE_WRITE',              N'Create, edit, move and delete pages and chapters'),
 (N'DOC_DIAGRAM_WRITE',           N'Create and edit BeeDiagram, Mermaid and isometric diagrams'),
 (N'DOC_SLIDES_WRITE',            N'Create and edit slide decks'),
 (N'DOC_TEMPLATE_MANAGE',         N'Save and delete app-wide slide deck templates'),
 (N'DOC_ATTACHMENT_WRITE',        N'Upload, replace and delete book attachments'),
 (N'DOC_IMAGE_UPLOAD',            N'Upload images embedded in pages'),
 (N'DOC_SHELF_MANAGE',            N'Create, edit, delete and publish shelves (reader websites)'),
 (N'DOC_AI_ASSIST',               N'Use LLM writing assistance in the page editor'),
-- Admin tier ------------------------------------------------------------
 (N'DOC_USER_MANAGE',             N'Manage BeeDocs user accounts, roles and sessions'),
 (N'DOC_STATS_VIEW',              N'View usage statistics and per-author activity'),
 (N'DOC_LLM_PROVIDER_MANAGE',     N'Configure LLM providers (OpenRouter, xAI, OpenAI, LM Studio)'),
 (N'DOC_STORAGE_PROVIDER_MANAGE', N'Configure storage providers and shelf storage assignment'),
 (N'DOC_REVISION_MANAGE',         N'Configure page change tracking and revision retention'),
 (N'DOC_SEARCH_REINDEX',          N'Trigger search reindex and index maintenance');

-- requires_edit_mode = 0: BeeDocs has no separate edit-mode concept; the write
-- actions themselves are the permission.
INSERT INTO rba.action
    (application_id, name, description, requires_edit_mode, is_active, created_date, modified_by)
SELECT @app_id, a.name, a.description, 0, 1, @now, @modified_by
FROM @actions a
WHERE NOT EXISTS (SELECT 1 FROM rba.action x
                  WHERE x.application_id = @app_id AND x.name = a.name);

PRINT CONCAT(CAST(@@ROWCOUNT AS varchar(10)), ' action(s) inserted.');

/* ---------------------------------------------------------------------------
   3. Groups (rba.role_plant)
   ------------------------------------------------------------------------ */
DECLARE @roles TABLE (name nvarchar(100) PRIMARY KEY, description nvarchar(100));

INSERT INTO @roles (name, description) VALUES
 (N'DOC_VIEWER', N'BeeDocs viewer - read, search, download, export and watch presentations'),
 (N'DOC_EDITOR', N'BeeDocs editor - viewer rights plus authoring of all content types'),
 (N'DOC_ADMIN',  N'BeeDocs administrator - full control incl. users, providers and maintenance');

INSERT INTO rba.role_plant
    (name, plant_cd, application_id, application_cd, description, is_active, created_date,
     request_by, request_justification, approved_by, approver_reason,
     approval_status, approved_date)
SELECT r.name, @plant_cd, @app_id, N'DOC', r.description, 1, @now,
       @modified_by, N'Initial RBA setup for BeeDocs', @modified_by, N'Initial setup',
       N'Approved', @now
FROM @roles r
WHERE NOT EXISTS (SELECT 1 FROM rba.role_plant x
                  WHERE x.application_id = @app_id AND x.name = r.name AND x.plant_cd = @plant_cd);

PRINT CONCAT(CAST(@@ROWCOUNT AS varchar(10)), ' group(s) inserted.');

/* ---------------------------------------------------------------------------
   4. Group -> action links (rba.role_action)
   ------------------------------------------------------------------------ */
DECLARE @map TABLE (role_name nvarchar(100), action_name nvarchar(100),
                    PRIMARY KEY (role_name, action_name));

-- DOC_VIEWER: read tier only
INSERT INTO @map (role_name, action_name) VALUES
 (N'DOC_VIEWER', N'DOC_CONTENT_READ'),
 (N'DOC_VIEWER', N'DOC_SEARCH'),
 (N'DOC_VIEWER', N'DOC_ATTACHMENT_DOWNLOAD'),
 (N'DOC_VIEWER', N'DOC_EXPORT'),
 (N'DOC_VIEWER', N'DOC_SLIDES_PRESENT');

-- DOC_EDITOR: everything the viewer has, plus the author tier
INSERT INTO @map (role_name, action_name)
SELECT N'DOC_EDITOR', action_name FROM @map WHERE role_name = N'DOC_VIEWER';

INSERT INTO @map (role_name, action_name) VALUES
 (N'DOC_EDITOR', N'DOC_BOOK_WRITE'),
 (N'DOC_EDITOR', N'DOC_PAGE_WRITE'),
 (N'DOC_EDITOR', N'DOC_DIAGRAM_WRITE'),
 (N'DOC_EDITOR', N'DOC_SLIDES_WRITE'),
 (N'DOC_EDITOR', N'DOC_TEMPLATE_MANAGE'),
 (N'DOC_EDITOR', N'DOC_ATTACHMENT_WRITE'),
 (N'DOC_EDITOR', N'DOC_IMAGE_UPLOAD'),
 (N'DOC_EDITOR', N'DOC_SHELF_MANAGE'),
 (N'DOC_EDITOR', N'DOC_AI_ASSIST');

-- DOC_ADMIN: every DOC action
INSERT INTO @map (role_name, action_name)
SELECT N'DOC_ADMIN', name FROM @actions;

-- role_action.id fills from its newsequentialid() default.
INSERT INTO rba.role_action (role_id, action_id, is_active, created_date, modified_by)
SELECT rp.id, a.id, 1, @now, @modified_by
FROM @map m
JOIN rba.role_plant rp ON rp.application_id = @app_id
                       AND rp.name = m.role_name
                       AND rp.plant_cd = @plant_cd
JOIN rba.action     a  ON a.application_id = @app_id
                       AND a.name = m.action_name
WHERE NOT EXISTS (SELECT 1 FROM rba.role_action ra
                  WHERE ra.role_id = rp.id AND ra.action_id = a.id);

PRINT CONCAT(CAST(@@ROWCOUNT AS varchar(10)), ' role_action link(s) inserted.');

COMMIT TRANSACTION;

/* ---------------------------------------------------------------------------
   Verification
   ------------------------------------------------------------------------ */
SELECT rp.name AS [group], rp.plant_cd, a.name AS [action], a.description
FROM rba.application app
JOIN rba.role_plant rp  ON rp.application_id = app.id
JOIN rba.role_action ra ON ra.role_id = rp.id
JOIN rba.action a       ON a.id = ra.action_id
WHERE app.application_cd = N'DOC'
ORDER BY rp.plant_cd, rp.name, a.name;

/* ---------------------------------------------------------------------------
   OPTIONAL: grant a user a BeeDocs group (template - fill in and uncomment).
   The user must already exist in rba.user_mes.

DECLARE @grant_user_cd nvarchar(100) = N'BROELANT';
DECLARE @grant_role    nvarchar(100) = N'DOC_ADMIN';
DECLARE @grant_plant   nvarchar(20)  = N'BOR';

INSERT INTO rba.user_role
    (user_id, user_cd, role_id, role_cd, is_active, can_assign, can_change_actions,
     request_by, request_justification, approved_by, approver_reason,
     approval_status, approved_date)
SELECT u.id, u.user_cd, rp.id, rp.name, 1, 1, 1,
       N'RBA_SETUP_BEEDOCS', N'Initial BeeDocs administrator',
       N'RBA_SETUP_BEEDOCS', N'Initial setup', N'Approved', SYSDATETIMEOFFSET()
FROM rba.user_mes u
JOIN rba.role_plant rp ON rp.name = @grant_role AND rp.plant_cd = @grant_plant
JOIN rba.application app ON app.id = rp.application_id AND app.application_cd = N'DOC'
WHERE u.user_cd = @grant_user_cd
  AND NOT EXISTS (SELECT 1 FROM rba.user_role ur
                  WHERE ur.user_id = u.id AND ur.role_id = rp.id AND ur.is_active = 1);
   ------------------------------------------------------------------------ */
