#!/bin/bash

# Script to remove translation keys from translated.cache files
# Usage: ./remove-from-cache.sh key1 key2 key3 ...
# Example: ./remove-from-cache.sh mail.promotionalCtaSubtitle mail.promotionalSaleSubject

if [ $# -eq 0 ]; then
    echo "Error: No translation keys provided"
    echo "Usage: $0 key1 key2 key3 ..."
    echo "Example: $0 mail.promotionalCtaSubtitle mail.promotionalSaleSubject"
    exit 1
fi

cd "$(dirname "$0")/.."

# Store all keys in a comma-separated string for Python
KEYS=""
for key in "$@"; do
    if [ -z "$KEYS" ]; then
        KEYS="'$key'"
    else
        KEYS="$KEYS, '$key'"
    fi
done

echo "Removing keys: $@"
echo ""

# Remove from src/locales cache
if [ -f "src/locales/translated.cache" ]; then
    python3 -c "
import json
keys_to_remove = [$KEYS]
with open('src/locales/translated.cache', 'r') as f:
    cache = json.load(f)
removed = []
for key in keys_to_remove:
    if key in cache:
        del cache[key]
        removed.append(key)
if removed:
    with open('src/locales/translated.cache', 'w') as f:
        json.dump(cache, f, indent=2)
    print(f'✓ Removed {len(removed)} keys from src/locales cache: {\", \".join(removed)}')
else:
    print('ℹ No keys found in src/locales cache')
"
else
    echo "ℹ src/locales/translated.cache does not exist"
fi

echo ""

# Remove from build/locales cache
if [ -f "build/locales/translated.cache" ]; then
    python3 -c "
import json
keys_to_remove = [$KEYS]
with open('build/locales/translated.cache', 'r') as f:
    cache = json.load(f)
removed = []
for key in keys_to_remove:
    if key in cache:
        del cache[key]
        removed.append(key)
if removed:
    with open('build/locales/translated.cache', 'w') as f:
        json.dump(cache, f, indent=2)
    print(f'✓ Removed {len(removed)} keys from build/locales cache: {\", \".join(removed)}')
else:
    print('ℹ No keys found in build/locales cache')
"
else
    echo "ℹ build/locales/translated.cache does not exist"
fi

echo ""

# Remove from assets/i18n cache
if [ -f "assets/i18n/translated.cache" ]; then
    python3 -c "
import json
keys_to_remove = [$KEYS]
with open('assets/i18n/translated.cache', 'r') as f:
    cache = json.load(f)
removed = []
for key in keys_to_remove:
    if key in cache:
        del cache[key]
        removed.append(key)
if removed:
    with open('assets/i18n/translated.cache', 'w') as f:
        json.dump(cache, f, indent=2)
    print(f'✓ Removed {len(removed)} keys from assets/i18n cache: {\", \".join(removed)}')
else:
    print('ℹ No keys found in assets/i18n cache')
"
else
    echo "ℹ assets/i18n/translated.cache does not exist"
fi

echo ""
echo "✓ Done!"
