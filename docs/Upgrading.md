# Upgrading an existing database

The table check adds new tables and columns on start, but never changes a primary key (mr-moqui
`docs/Run-Deploy.md`, Upgrading). A Mantle entity whose key changed needs its table rebuilt once on a database made
before the change. A new database needs nothing.

## ProductStoreProduct: dated store publication (Commerce P3, November 2026)

`mantle.product.store.ProductStoreProduct` is now effective dated: `fromDate` joined its key (store, product,
fromDate). An older database keeps the old key (store, product) and gains a nullable `fromDate`. Reads still work, since a
row with no date counts as open. But a second row for the same product in a store fails on the old key: a withdrawal
followed by a new publication, a scheduled publication, or a change to the storefront details. That second row is
refused with the database's duplicate-key error.

Check the key first. A table with no rows, or one already on the new key, needs nothing:

```sql
SELECT kcu.column_name FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
   AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
 WHERE tc.constraint_type = 'PRIMARY KEY' AND lower(tc.table_name) = 'product_store_product';
```

To rebuild, stop the server and take a backup ([Upgrading](https://github.com/moqui/mr-moqui/blob/master/docs/Run-Deploy.md#upgrading)
step 1). Then start the new build once, so the table check adds the new columns, and stop it again. Each row gets a
start date. Rows from before the change were published all along, so any date before the first order will do; the one below
is January 1, 2000. Then put the key on the three fields:

PostgreSQL (names in lower case; the constraint name is the one the query above found, usually
`product_store_product_pkey`):

```sql
BEGIN;
UPDATE product_store_product SET from_date = TIMESTAMP '2000-01-01 00:00:00' WHERE from_date IS NULL;
ALTER TABLE product_store_product DROP CONSTRAINT product_store_product_pkey;
ALTER TABLE product_store_product ADD PRIMARY KEY (product_store_id, product_id, from_date);
COMMIT;
```

MySQL (names as the database has them; the table changes are not transactional, so the backup is the rollback):

```sql
UPDATE PRODUCT_STORE_PRODUCT SET FROM_DATE = '2000-01-01 00:00:00' WHERE FROM_DATE IS NULL;
ALTER TABLE PRODUCT_STORE_PRODUCT DROP PRIMARY KEY, ADD PRIMARY KEY (PRODUCT_STORE_ID, PRODUCT_ID, FROM_DATE);
```

Start the server. The query above should list the three columns. Publishing, withdrawing and publishing a product again
in Commerce's Assortment should now work.

## PublicSitePage: pages by mount and route (Commerce P4, November 2026)

`mantle.public.PublicSitePage` is now keyed by a sequenced `sitePageId`, so a site has pages beyond its Forum roles: a
page of a Shop mount by route and locale, with its role (the Forum's guidelines and about, or a policy role) optional and
unique within the site when set (the `PASS_PAGE_ROLE` index). An older database keeps the old key (site, role) and gains a
nullable `site_page_id`. The Forum's guidelines and about pages still read, but a new binding fails: the Forum's first
publication of a page needs the new key, and Commerce's pages, which have no role, cannot be stored at all.

Check the key first. A table with no rows still needs the key changed, so check it on any database made before November
2026:

```sql
SELECT kcu.column_name FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
   AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
 WHERE tc.constraint_type = 'PRIMARY KEY' AND lower(tc.table_name) = 'public_site_page';
```

When it lists `site_id` and `page_role`, stop the server and take a backup, start the new build once so the table check
adds the new columns, and stop it again. Each row gets a key made of its site and role (an id of at most 40 characters;
the sequence gives new pages numeric ids, so these never collide), and the key moves to it. The role becomes optional and
unique within its site:

The table check may have made the `PASS_PAGE_ROLE` index already (the old key kept site and role unique), so each step
below makes it only when it is missing.

PostgreSQL (the constraint name is the one the query above found, usually `public_site_page_pkey`; `IF NOT EXISTS` skips
an index the table check made):

```sql
BEGIN;
UPDATE public_site_page SET site_page_id = left(site_id || '_' || page_role, 40) WHERE site_page_id IS NULL;
ALTER TABLE public_site_page DROP CONSTRAINT public_site_page_pkey;
ALTER TABLE public_site_page ALTER COLUMN page_role DROP NOT NULL;
ALTER TABLE public_site_page ADD PRIMARY KEY (site_page_id);
CREATE UNIQUE INDEX IF NOT EXISTS pass_page_role ON public_site_page (site_id, page_role);
COMMIT;
```

MySQL (names as the database has them; the table changes are not transactional, so the backup is the rollback):

```sql
UPDATE PUBLIC_SITE_PAGE SET SITE_PAGE_ID = LEFT(CONCAT(SITE_ID, '_', PAGE_ROLE), 40) WHERE SITE_PAGE_ID IS NULL;
ALTER TABLE PUBLIC_SITE_PAGE DROP PRIMARY KEY, MODIFY PAGE_ROLE VARCHAR(40) NULL, ADD PRIMARY KEY (SITE_PAGE_ID);
SELECT INDEX_NAME FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND UPPER(TABLE_NAME) = 'PUBLIC_SITE_PAGE' AND UPPER(INDEX_NAME) = 'PASS_PAGE_ROLE';
```

MySQL has no `IF NOT EXISTS` for an index: only when that last query lists nothing, make it:

```sql
CREATE UNIQUE INDEX PASS_PAGE_ROLE ON PUBLIC_SITE_PAGE (SITE_ID, PAGE_ROLE);
```

Start the server. The query above should list `site_page_id` alone, and the Forum's guidelines and about pages read as
before. No shipped data file has PublicSitePage rows; a data file of your own that names one by site and role still loads
once its rows carry a `sitePageId`.

## ZZW_RETAIL's public page address (Shop P3, November 2026; demo data only)

The demo wiki space `ZZW_RETAIL` (`data/ZcaProductDemoData.xml`) no longer points at PopRestStore's `/popc` pages: its
`publicPageUrl` is the demo Shop site's article page (`https://shop.zizi.localhost/support/CustomerArticle?wikiPageId=...`),
its `publicAttachmentUrl` is empty (PASS serves no wiki file), and the `/pcontact` screen path alias is gone. Data files
load only into a new database, so a demo database made before keeps the old values. Nothing breaks: Knowledge.js links an
article to the organization's Support mount when a published site has one, whatever the space says. To match a new
database, update the space and end the alias:

```sql
UPDATE wiki_space SET public_page_url = 'https://shop.zizi.localhost/support/CustomerArticle?wikiPageId=${wikiPageId}',
       public_attachment_url = NULL WHERE wiki_space_id = 'ZZW_RETAIL';
UPDATE screen_path_alias SET thru_date = CURRENT_TIMESTAMP WHERE alias_path = '/pcontact' AND thru_date IS NULL;
```

(MySQL: the same statements with the table and column names in upper case.)
