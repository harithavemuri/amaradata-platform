#!/bin/bash
# Setup script for Git hooks
# Run this to enable the pre-commit/post-commit hooks

echo "========================================"
echo "  Git Hooks Setup"
echo "========================================"
echo ""

# Check if .git directory exists
if [ ! -d ".git" ]; then
    echo "Error: Not a git repository!"
    echo "Please run this from the project root."
    exit 1
fi

# Create hooks directory if it doesn't exist
mkdir -p .git/hooks

echo "Installing pre-commit/post-commit hooks..."

cp "scripts/pre-commit.template" ".git/hooks/pre-commit"
cp "scripts/post-commit.template" ".git/hooks/post-commit"
chmod +x .git/hooks/pre-commit .git/hooks/post-commit

echo "✅ Hooks installed and executable"
echo ""
echo "========================================"
echo "  Git Hooks Setup Complete!"
echo "========================================"
echo ""
echo "pre-commit: does nothing (intentional no-op)."
echo "The full test suite gates real deploys via 'npm run deploy' instead —"
echo "see scripts/pre-commit.template for why it moved out of this hook."
echo ""
echo "post-commit: runs 'npm run sync-tenant-fixes' best-effort, after the"
echo "commit has already landed — never blocks or delays committing."
echo ""
echo "To bypass a hook (not recommended):"
echo "  git commit --no-verify"
echo ""
