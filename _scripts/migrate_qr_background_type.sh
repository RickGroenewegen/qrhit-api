#!/bin/bash

# Migration script to add qrBackgroundType column to payment_has_playlist table
# This script should be run after deploying the new code

echo "Starting database migration for qrBackgroundType..."

# Navigate to API directory
cd /Users/rick/Sites/qrhit-api

# Push schema changes to database
echo "Pushing schema changes to database..."
npx prisma db push

echo "Migration complete!"
echo ""
echo "Notes:"
echo "- The new qrBackgroundType column has been added with default value 'square'"
echo "- The old hideCircle column is kept for backward compatibility"
echo "- Existing records with hideCircle=true will be interpreted as qrBackgroundType='none'"
echo "- New records should use qrBackgroundType instead of hideCircle"