#!/bin/sh
rm -rf lib
yarn build
cd lib/src
mv * ..
cd ..
rm -rf examples
rm -rf tests
rm -rf src
