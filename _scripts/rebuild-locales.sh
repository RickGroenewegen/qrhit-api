#!/bin/bash

# Script to rebuild the API and update locales in the build folder
# Usage: ./rebuild-locales.sh [key1 key2 key3 ...]
# Example: ./rebuild-locales.sh mail.promotionalCtaSubtitle mail.promotionalSaleSubject
#
# The API doesn't use a translation cache like the frontend.
# It reads directly from JSON files, so rebuilding copies the updated
# locale files from src/locales to build/locales.
#
# Keys are optional - they are just logged for documentation purposes.

cd "$(dirname "$0")/.."

if [ $# -gt 0 ]; then
    echo "Updating translation keys: $@"
    echo ""
fi

echo "Rebuilding API to update locales..."
echo ""

npm run build

if [ $? -eq 0 ]; then
    echo ""
    echo "✓ Build completed successfully!"
    echo "✓ Locales have been updated in build/locales/"
    if [ $# -gt 0 ]; then
        echo "✓ Updated keys: $@"
    fi
else
    echo ""
    echo "✗ Build failed!"
    exit 1
fi
