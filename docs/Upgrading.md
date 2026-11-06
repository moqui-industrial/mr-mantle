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
