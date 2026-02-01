#!/bin/bash
set -e

# Configuration
BUILD_DIR="landing-page/dist"
BRANCH="gh-pages"

echo "Deploying to $BRANCH from $BUILD_DIR..."

# Check if dist directory exists
if [ ! -d "$BUILD_DIR" ]; then
  echo "Error: $BUILD_DIR does not exist. Run 'pnpm build' in landing-page directory first."
  exit 1
fi

# Create a temporary directory for the deployment
TEMP_DIR=$(mktemp -d)
echo "Using temporary directory: $TEMP_DIR"

# Copy build artifacts to temp dir
cp -r "$BUILD_DIR/"* "$TEMP_DIR/"

# Switch to the target branch (create it if it doesn't exist)
if git show-ref --verify --quiet refs/heads/$BRANCH; then
  echo "Branch $BRANCH exists. checking out..."
  git checkout $BRANCH
else
  echo "Branch $BRANCH does not exist. Creating orphan branch..."
  git checkout --orphan $BRANCH
fi

# Clean current directory (except .git)
echo "Cleaning working directory..."
git rm -rf .
git clean -fxd

# Copy files from temp dir back to working directory
echo "Copying build artifacts..."
cp -r "$TEMP_DIR/"* .

# Add changes
git add .

# Commit
echo "Committing..."
git commit -m "Deploy landing page [skip ci]"

echo "Deployment branch $BRANCH is ready."
echo "To push: git push origin $BRANCH"

# Clean up
rm -rf "$TEMP_DIR"
