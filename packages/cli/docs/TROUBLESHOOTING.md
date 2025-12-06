# Troubleshooting Guide

## Common Issues

### MongoDB Connection Issues

#### Problem: Cannot Connect to MongoDB

```bash
Error: MongoServerError: connect ECONNREFUSED 127.0.0.1:27017
```

**Solutions:**

1. Check if MongoDB is running:

```bash
# Check MongoDB status
brew services list | grep mongodb

# Start MongoDB if needed
brew services start mongodb-community
```

2. Verify MongoDB URI in configuration:

```json
{
  "mongodb": {
    "uri": "mongodb://localhost:27017/blockingmachine",
    "options": {
      "maxPoolSize": 10
    }
  }
}
```

### Memory Issues

#### Problem: JavaScript Heap Out of Memory

```bash
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed
```

**Solutions:**

1. Increase Node.js memory limit:

```bash
export NODE_OPTIONS="--max-old-space-size=4096"
```

2. Enable batch processing in configuration:

```json
{
  "performance": {
    "processing": {
      "batchSize": 1000,
      "parallel": 2
    }
  }
}
```

### Permission Issues

#### Problem: Cannot Write to Output Directory

```bash
Error: EACCES: permission denied, open './filters/output/adguard.txt'
```

**Solutions:**

1. Fix directory permissions:

```bash
# Check current permissions
ls -la ./filters/output

# Fix permissions
chmod 755 ./filters/output
```

2. Update output directory in configuration:

```json
{
  "output": {
    "directory": "$HOME/blockingmachine/filters"
  }
}
```

### Import Issues

#### Problem: Rules Not Being Imported

```bash
Warning: No rules imported from source "ExampleList"
```

**Solutions:**

1. Check source configuration:

```json
{
  "sources": [
    {
      "name": "ExampleList",
      "url": "https://example.com/rules.txt",
      "enabled": true
    }
  ]
}
```

2. Verify network connectivity:

```bash
# Test URL accessibility
curl -I https://example.com/rules.txt
```

### Export Issues

#### Problem: Missing Export Format

```bash
Error: Unsupported export format "customformat"
```

**Solutions:**

1. Check available formats:

```bash
blockingmachine export --help
```

2. Use correct format name:

```bash
blockingmachine export adguard
```

## Diagnostic Tools

### View Database Status

```bash
# Check database statistics
blockingmachine view

# View sample rules
blockingmachine view --sample 10
```

### Validate Configuration

```bash
# Check configuration
blockingmachine validate

# Fix common issues
blockingmachine validate --fix
```

### Debug Mode

```bash
# Enable debug logging
blockingmachine --debug import

# Save debug logs
blockingmachine --debug import > debug.log 2>&1
```

## Log Files

### Location

- Error logs: `./logs/error.log`
- Combined logs: `./logs/combined.log`
- Debug logs: `./logs/debug.log`

### Viewing Logs

```bash
# View last 50 error logs
tail -n 50 ./logs/error.log

# Search logs for specific error
grep "MongoServerError" ./logs/combined.log
```

## Performance Issues

### Slow Import Processing

**Solutions:**

1. Enable caching:

```json
{
  "performance": {
    "caching": {
      "enabled": true,
      "ttl": 3600,
      "maxSize": "100mb"
    }
  }
}
```

2. Adjust batch processing:

```json
{
  "performance": {
    "processing": {
      "batchSize": 2000,
      "parallel": 4,
      "timeout": 60000
    }
  }
}
```

## Getting Help

### Community Support

- [GitHub Issues](https://github.com/greigh/blockingmachine/issues)
- [GitHub Discussions](https://github.com/greigh/blockingmachine/discussions)

### Reporting Bugs

When reporting issues, include:

1. CLI version: `blockingmachine --version`
2. Node.js version: `node --version`
3. MongoDB version: `mongod --version`
4. Configuration file (remove sensitive data)
5. Error logs
6. Steps to reproduce
