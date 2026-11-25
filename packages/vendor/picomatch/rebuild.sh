#!/usr/bin/env bash
# Rebuild with npm 10 (as shipped with Node 22). npm ci uses the checked-in tarballs.
set -euo pipefail
dest=$(cd "$(dirname "$0")" && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

backport() (
  version=$1
  integrity=$2
  base=$3
  head=$4
  mkdir "$scratch/$version"
  cd "$scratch/$version"
  npm pack --ignore-scripts --silent "picomatch@$version"
  archive="picomatch-$version.tgz"
  actual=$(openssl dgst -sha512 -binary "$archive" | openssl base64 -A)
  [[ "$actual" == "$integrity" ]]
  tar -xzf "$archive"

  for revision in "$base" "$head"; do
    curl --fail --silent --show-error --location \
      "https://raw.githubusercontent.com/micromatch/picomatch/$revision/lib/parse.js" -o "$revision.js"
  done
  diff -u "$base.js" "$head.js" > parser.patch || [[ $? == 1 ]]
  patch -F 0 package/lib/parse.js < parser.patch
  cd package
  npm pkg set "version=$version-acclimate.1"
  npm pack --ignore-scripts --silent --pack-destination "$dest"
)

backport 2.3.2 'V7+vQEJ06Z+c5tSye8S+nHUfI51xoXIXjHQ99cQtKUkQqqO1kO/KCJUfZXuB47h/YBlDhah2H3hdUGXn8ie0oA==' \
  81cba8d4b767cab3cb29d26eb4f691eed75b73b2 9ca61909ab0ec680953e21bac80a6e825e1ede81
backport 4.0.7 'qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==' \
  9fab7bf61913ea334c4203ed321c426cfde44a42 3222059ac27492d9c0147fee5c65f751bbd851ab
