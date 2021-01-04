#!/bin/sh
rm -rf lib
yarn format
yarn tsc
cd lib
mv src/* .
rm -rf tests
rm -rf src
