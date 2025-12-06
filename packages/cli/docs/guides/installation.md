# Installation Guide

## Prerequisites

Before installing Blockingmachine CLI, ensure you have:

- Node.js v20 or later
- MongoDB v6.0 or later
- npm v9 or later
- (Optional) macOS 12 or later (for native Apple Silicon support)

## Quick Install

```bash
# Install globally
npm install -g @blockingmachine/cli

# Verify installation
blockingmachine --version
```

## Development Setup

1. Clone the repository:

```bash
git clone https://github.com/greigh/blockingmachine.git
cd blockingmachine
```

2. Install dependencies:

```bash
npm install
```

3. Setup MongoDB:

```bash
# Using Homebrew
brew tap mongodb/brew
brew install mongodb-community

# Start MongoDB service
brew services start mongodb-community
```

4. Create configuration:

```bash
# Initialize configuration
blockingmachine init

# Verify configuration
blockingmachine validate
```

## Directory Structure

```
$HOME/
├── .blockingmachinerc.json     # Configuration file
└── .blockingmachine/
    ├── filters/                # Filter lists
    │   ├── input/             # Source files
    │   └── output/            # Generated files
    ├── logs/                  # Log files
    └── cache/                 # Cache directory
```

## Environment Setup

1. Set Node.js options:

```bash
# Add to your ~/.zshrc or ~/.bash_profile
export NODE_OPTIONS="--max-old-space-size=4096"
```

2. Configure MongoDB access:

```bash
# Add to your ~/.zshrc or ~/.bash_profile
export BLOCKINGMACHINE_MONGODB_URI="mongodb://localhost:27017/blockingmachine"
```

3. Setup paths:

```bash
# Add to your ~/.zshrc or ~/.bash_profile
export BLOCKINGMACHINE_HOME="$HOME/.blockingmachine"
export PATH="$PATH:$BLOCKINGMACHINE_HOME/bin"
```

## Verification

1. Check system requirements:

```bash
# Check Node.js version
node --version  # Should be ≥ v20.0.0

# Check MongoDB version
mongod --version  # Should be ≥ v6.0.0

# Check npm version
npm --version  # Should be ≥ v9.0.0
```

2. Verify installation:

```bash
# Check CLI version
blockingmachine --version

# Test configuration
blockingmachine validate

# Check MongoDB connection
blockingmachine test mongodb
```

## Troubleshooting

### Common Installation Issues

1. **Node.js Version Mismatch**

```bash
# Using nvm to install correct version
nvm install 20
nvm use 20
```

2. **MongoDB Connection Issues**

```bash
# Check MongoDB service
brew services list | grep mongodb

# Restart MongoDB if needed
brew services restart mongodb-community
```

3. **Permission Issues**

```bash
# Fix npm permissions
sudo chown -R $USER:$GROUP ~/.npm
sudo chown -R $USER:$GROUP ~/.blockingmachine
```

See [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) for more detailed troubleshooting guides.

## Updating

```bash
# Update global installation
npm update -g @blockingmachine/cli

# Update development installation
git pull
npm install
```

## Uninstalling

```bash
# Remove global installation
npm uninstall -g @blockingmachine/cli

# Clean up files
rm -rf ~/.blockingmachine
rm ~/.blockingmachinerc.json

# Stop MongoDB if no longer needed
brew services stop mongodb-community
```
