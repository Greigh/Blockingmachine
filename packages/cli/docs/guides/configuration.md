# Configuration Guide

## Quick Start

Create a new configuration file:

```bash
blockingmachine init
```

This creates `.blockingmachinerc.json` in your home directory.

## Configuration File Structure

```json
{
  "mongodb": {
    "uri": "mongodb://localhost:27017/blockingmachine",
    "options": {
      "maxPoolSize": 10
    }
  },
  "output": {
    "directory": "./filters/output"
  },
  "meta": {
    "title": "My Filter List",
    "description": "Custom filter list",
    "homepage": "https://example.com",
    "expires": "1 day"
  },
  "sources": [],
  "performance": {
    "processing": {
      "batchSize": 1000,
      "parallel": 4
    }
  }
}
```

## Required Settings

### MongoDB Configuration
```json
{
  "mongodb": {
    "uri": "mongodb://localhost:27017/blockingmachine",
    "options": {
      "maxPoolSize": 10,
      "connectTimeoutMS": 5000,
      "socketTimeoutMS": 45000
    }
  }
}
```

### Output Directory
```json
{
  "output": {
    "directory": "./filters/output",
    "permissions": "755"
  }
}
```

## Filter Sources

### Adding Sources
```json
{
  "sources": [
    {
      "name": "EasyPrivacy",
      "url": "https://easylist.to/easylist/easyprivacy.txt",
      "category": "privacy",
      "enabled": true,
      "priority": 90,
      "tags": ["trusted"],
      "update": "daily"
    }
  ]
}
```

### Source Options
- `name`: Unique identifier
- `url`: Direct URL to filter list
- `category`: One of: privacy, security, advertising, mobile, custom
- `enabled`: Boolean to enable/disable
- `priority`: 1-100 (higher = more important)
- `tags`: Array of custom tags
- `update`: update frequency (hourly, daily, weekly)

## Performance Tuning

### Processing Options
```json
{
  "performance": {
    "processing": {
      "batchSize": 1000,
      "parallel": 4,
      "timeout": 30000
    },
    "caching": {
      "enabled": true,
      "ttl": 3600,
      "maxSize": "100mb"
    }
  }
}
```

### Memory Management
```json
{
  "performance": {
    "memory": {
      "maxOldSpace": "4096",
      "gcInterval": 1000
    }
  }
}
```

## Metadata Configuration

### Filter List Information

```json
{
  "meta": {
    "title": "My Filter List",
    "description": "Blockingmachine filter list combining multiple sources",
    "homepage": "https://example.com",
    "version": "1.0.0",
    "expires": "1 day",
    "license": "BSD-3-Clause",
  }
}
```

## Environment Variables

Override configuration using environment variables:

```bash
# MongoDB
export BLOCKINGMACHINE_MONGODB_URI="mongodb://localhost:27017/blockingmachine"
export BLOCKINGMACHINE_MONGODB_MAX_POOL_SIZE="20"

# Output
export BLOCKINGMACHINE_OUTPUT_DIR="$HOME/filters"

# Performance
export BLOCKINGMACHINE_BATCH_SIZE="2000"
export BLOCKINGMACHINE_PARALLEL="4"
```

## Configuration Validation

Validate your configuration:

```bash
# Check configuration
blockingmachine validate

# Fix common issues
blockingmachine validate --fix

# Show detailed validation results
blockingmachine validate --verbose
```

## Examples

### Basic Configuration
```json
{
  "mongodb": {
    "uri": "mongodb://localhost:27017/blockingmachine"
  },
  "output": {
    "directory": "./filters/output"
  },
  "sources": [
    {
      "name": "EasyPrivacy",
      "url": "https://easylist.to/easylist/easyprivacy.txt",
      "category": "privacy",
      "enabled": true
    }
  ]
}
```

### Advanced Configuration
```json
{
  "mongodb": {
    "uri": "mongodb://localhost:27017/blockingmachine",
    "options": {
      "maxPoolSize": 10,
      "connectTimeoutMS": 5000
    }
  },
  "output": {
    "directory": "./filters/output",
    "permissions": "755"
  },
  "meta": {
    "title": "Custom Filter List",
    "description": "Combined filters for privacy and security",
    "homepage": "https://example.com",
    "expires": "1 day"
  },
  "sources": [
    {
      "name": "EasyPrivacy",
      "url": "https://easylist.to/easylist/easyprivacy.txt",
      "category": "privacy",
      "enabled": true,
      "priority": 90,
      "tags": ["trusted"]
    },
    {
      "name": "Custom",
      "url": "https://example.com/custom-rules.txt",
      "category": "custom",
      "enabled": true,
      "priority": 100
    }
  ],
  "performance": {
    "processing": {
      "batchSize": 1000,
      "parallel": 4,
      "timeout": 30000
    },
    "caching": {
      "enabled": true,
      "ttl": 3600,
      "maxSize": "100mb"
    },
    "memory": {
      "maxOldSpace": "4096",
      "gcInterval": 1000
    }
  }
}
```

See [EXAMPLES.md](../EXAMPLES.md) for more configuration examples.