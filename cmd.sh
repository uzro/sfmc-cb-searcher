#!/bin/bash

# packaging src to tar.gz with version number
# get version number from manifest file 
version=$(grep '"version"' ./src/manifest.json | awk -F'"' '{print $4}')
echo "Packaging version $version"

# create dist directory if not exist
[ ! -d ./dist ] && mkdir -p ./dist

# create zip
# if zip is not installed, install it first
[ ! -x "$(command -v zip)" ] && sudo apt-get install -y zip
zip -r ./dist/smfc-ds-$version.zip ./src
