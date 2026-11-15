# Fit Agent parser-structure fixtures

**These are NOT product data.** They are small hand-written HTML pages that copy the *structure*
of an Amazon product page (ids such as `productTitle`, `feature-bullets`, `input[name=ASIN]`,
the size selector and a size-chart table) so the parser can be unit-tested without network.
The ASINs (`B0PARSER01`, `B0PARSER02`, `B0PARSER03`) are fake and every number is invented for
the test. Real product pages saved by the user live in `data/amazon-pages/` (gitignored) and the
saved-page tests skip with a message when that folder is empty.

Rules-parser structure cases (ASINs `B0PARSER05`-`B0PARSER08`, all invented): several chart tables
picked by title words (`multitable`) or by size rows then "Regular" (`multitable-size`), tables that
stay tied (`multitable-tied`), and body words against garment-shaped numbers (`conflict`).
