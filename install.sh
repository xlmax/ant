#!/bin/sh
set -eu

# Репозиторий GitHub в формате owner/repo.
REPO="xlmax/ant"

if ! command -v npm >/dev/null 2>&1; then
  echo "Ошибка: npm не найден. Установите Node.js (>= 20.12)." >&2
  exit 1
fi

tag=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" |
  grep -o '"tag_name": *"[^"]*"' |
  cut -d'"' -f4)

if [ -z "$tag" ]; then
  echo "Ошибка: не удалось определить последний релиз для ${REPO}." >&2
  exit 1
fi

version="${tag#v}"
url="https://github.com/${REPO}/releases/download/${tag}/ant-${version}.tgz"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Устанавливаю ant ${version} ..."
curl -fsSL "$url" -o "$tmp/ant.tgz"
npm install -g "$tmp/ant.tgz"

echo "Готово. Запустите: ant"
