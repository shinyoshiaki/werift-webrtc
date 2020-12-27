#!/bin/sh
rm -rf lib
yarn fix
yarn unused
yarn format
yarn test
yarn build
cd lib
mv src/* .
rm -rf examples
rm -rf tests
rm -rf src
