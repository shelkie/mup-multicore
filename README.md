# MUP Multi-Core Plugin

A Meteor Up (MUP) plugin that enables full CPU utilization by deploying multiple Docker containers for your Meteor application.

## What it does

This plugin automatically:
1. **Deploys additional worker containers** alongside your main MUP container
2. **Auto-detects CPU cores** or uses a specified number of instances
3. **Sets up nginx load balancing** (optional, for web-facing servers)
4. **Maintains MUP compatibility** - all standard MUP commands work normally
5. **Provides environment variables** for container identification (`CORE_ID`)

## Why use this?

By default, MUP deploys a single Docker container with one Node.js process, which only uses one CPU core. This plugin creates additional worker containers to utilize all available CPU cores, dramatically improving performance for CPU-intensive applications.

## Architecture

```
Main Container (MUP-managed):  app-name        :3000  (CORE_ID=0)
Worker Container 1:            app-name-worker-1:3001  (CORE_ID=1)  
Worker Container 2:            app-name-worker-2:3002  (CORE_ID=2)
Worker Container 3:            app-name-worker-3:3003  (CORE_ID=3)
```

## Installation

### Install via npm

```bash
npm install -g mup-multicore
```

Or install locally:
```bash
npm install mup-multicore
```

### Add to MUP configuration

```js
module.exports = {
  plugins: ['mup-multicore'],
  
  multiCore: {
    instances: 'auto',    // or specify a number
    startingPort: 3001,   // port for first worker (optional)
    useNginx: false      // enable nginx load balancing (optional)
  },
  
  // ... rest of your MUP config
};
```

## Configuration Options

### Global Configuration

```js
multiCore: {
  instances: 'auto',     // 'auto' (detects CPU cores) or number (e.g., 4)
  startingPort: 3001,    // Starting port for worker containers (default: 3001)
  useNginx: false        // Whether to set up nginx load balancing (default: false)
}
```

### Per-Server Configuration

For mixed deployments (web servers + backend workers):

```js
module.exports = {
  plugins: ['mup-multicore'],
  
  // Global defaults
  multiCore: {
    instances: 'auto',
    startingPort: 3001,
    useNginx: false  // Default: no nginx (backend workers)
  },
  
  servers: {
    web1: { host: '1.2.3.4' },
    web2: { host: '5.6.7.8' },
    worker1: { host: '9.10.11.12' },
    worker2: { host: '13.14.15.16' }
  },
  
  app: {
    servers: {
      // Web servers - enable nginx load balancing
      web1: { 
        multiCore: { useNginx: true }
      },
      web2: { 
        multiCore: { useNginx: true }
      },
      // Backend workers - use defaults (no nginx)
      worker1: {},  
      worker2: {}
    }
  }
};
```

## Application Integration

### Worker Identification

The plugin sets a `CORE_ID` environment variable in each container. Add this to your MUP config:

```js
app: {
  env: {
    CORE_ID: 0,  // For the main container
    // ... your other env vars
  }
}
```

### In your application code:

```js
// Get consistent worker ID across all containers
App.getWorkerId = function() {
  const hostname = os.hostname();
  const coreId = process.env.CORE_ID || '0';
  return `${hostname}-core-${coreId}`;
};
```

This generates IDs like:
- Main container: `www1-myapp-core-0`
- Worker 1: `www1-myapp-1-core-1`
- Worker 2: `www1-myapp-2-core-2`

## Usage

### Standard MUP Commands

All MUP commands work normally and automatically manage worker containers:

```bash
mup deploy    # Deploys main + starts workers
mup start     # Starts main + workers  
mup stop      # Stops main + workers
mup restart   # Restarts main + workers
mup logs      # Shows main container logs
```

### Plugin-Specific Commands

```bash
mup multicore logs    # Shows logs from all containers (main + workers)
```

## Use Cases

### Backend Workers (No nginx)
Perfect for pure backend processing, job queues, APIs accessed through external load balancers:

```js
multiCore: {
  instances: 'auto',
  useNginx: false  // No web server needed
}
```

### Web Servers (With nginx)
For web-facing applications that need load balancing:

```js
multiCore: {
  instances: 'auto', 
  useNginx: true   // Sets up nginx upstream
}
```

### Mixed Deployment
Some servers handle web traffic, others are pure backend workers:

```js
app: {
  servers: {
    web1: { multiCore: { useNginx: true } },   // Web server
    worker1: { multiCore: { useNginx: false } } // Backend worker
  }
}
```

## How It Works

1. **Deploy Phase**: Creates additional Docker containers alongside the main MUP container
2. **Nginx Setup**: (Optional) Configures nginx upstream for load balancing across containers
3. **Container Management**: Automatically starts/stops/restarts worker containers with MUP commands
4. **Environment Variables**: Sets `CORE_ID` for container identification

## Compatibility

- ✅ MUP 1.5+
- ✅ `zodern/meteor` Docker image  
- ✅ All standard MUP features (SSL, environment variables, etc.)
- ✅ Multiple server deployments
- ✅ Mixed server types (web + backend workers)

## Verification

Check that containers are running:

```bash
mup ssh
docker ps
```

You should see:
- `myapp` (main container)
- `myapp-worker-1` (worker container)
- `myapp-worker-2` (worker container)
- etc.

## Performance Impact

On a 4-core server, you should see ~4x improvement in CPU-intensive tasks compared to a single container deployment. 