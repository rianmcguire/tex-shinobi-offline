# tex-shinobi-offline

The [TEX Shinobi keyboard](https://tex.com.tw/products/shinobi) has a [proprietary online configuration tool](https://program.tex.com.tw/shinobi/) that generates .TEX configuration files for loading onto the keyboard. I don't want my keyboard to be unconfigurable when the site inevitably disappears.

This is a blatant rip of the site that I've hacked up to work offline, including reverse-engineered .TEX generation and parsing.

## Features

- Completely offline. No account, no proprietary backend server.
- Imports existing .TEX files.

## Using it

- Clone the repo and open `site/index.html`.

## Tests

The reverse-engineered generator and parser have a test suite that runs in Node.js. Run `./tests/test.js`.

In `tests/fixtures/`, the `.json` files are payloads that were sent to the original backend at https://yoda2.tedshd.io/, and the `.tex` files are the responses. The generator and parser can roundtrip all of these, and get byte-for-byte identical results.

## Quality

Slop coded, but works for my config. I've cleaned up the generator code a little. The UI integration and importer haven't been touched.
