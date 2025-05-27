// Multi-Container Plugin for MUP
// Deploys additional worker containers alongside main MUP container

function getInstanceCount(config, serverName) {
  // Check server-specific config first, then global config
  const serverConfig = config.app?.servers?.[serverName]?.multiCore;
  const globalConfig = config.multiCore;
  return serverConfig?.instances || globalConfig?.instances || 'auto';
}

function getStartingPort(config, serverName) {
  // Check server-specific config first, then global config
  const serverConfig = config.app?.servers?.[serverName]?.multiCore;
  const globalConfig = config.multiCore;
  return serverConfig?.startingPort || globalConfig?.startingPort || 3001;
}

function shouldUseNginx(config, serverName) {
  // Check server-specific config first, then global config
  const serverConfig = config.app?.servers?.[serverName]?.multiCore;
  const globalConfig = config.multiCore;
  return serverConfig?.useNginx || globalConfig?.useNginx || false;
}

async function detectCores(api, serverName) {
  const config = api.getConfig();
  const server = config.servers[serverName];
  
  try {
    const result = await api.runSSHCommand(server, 'nproc');
    return parseInt(result.output.trim());
  } catch (error) {
    console.log(`⚠️ Could not detect cores on ${serverName}, defaulting to 2`);
    return 2;
  }
}

async function updateMupNginx(api) {
  const config = api.getConfig();
  const servers = config.app.servers || {};
  const appName = config.app.name;
  
  console.log('🔧 Updating MUP nginx configuration for load balancing...');
  
  return Promise.all(
    Object.keys(servers).map(async serverName => {
      // Skip nginx update for servers that don't need it
      if (!shouldUseNginx(config, serverName)) {
        console.log(`⏭️ Skipping nginx update for ${serverName} (backend worker)`);
        return;
      }
      
      const server = config.servers[serverName];
      const instanceCount = getInstanceCount(config, serverName);
      const startingPort = getStartingPort(config, serverName);
      const cores = instanceCount === 'auto' ? await detectCores(api, serverName) : instanceCount;
      
      try {
        // Create upstream block for MUP's nginx
        let upstream = 'upstream meteor_backend {\n';
        upstream += '  server 127.0.0.1:3000;\n'; // Main MUP container
        for (let i = 1; i < cores; i++) { // Additional worker containers
          upstream += `  server 127.0.0.1:${startingPort + i - 1};\n`;
        }
        upstream += '}\n';
        
        // Update MUP's nginx config to use upstream
        await api.runSSHCommand(server, `sudo cp /opt/${appName}/config/env.list /tmp/${appName}.env.backup`);
        
        // Create nginx upstream configuration that works with MUP
        await api.runSSHCommand(server, `cat > /tmp/${appName}-upstream.conf << 'EOF'
${upstream}
EOF`);
        
        // Find and update MUP's nginx config
        await api.runSSHCommand(server, `
          if [ -f /etc/nginx/sites-enabled/default ]; then
            sudo sed -i 's/proxy_pass.*3000;/proxy_pass http:\\/\\/meteor_backend;/g' /etc/nginx/sites-enabled/default
          fi
        `);
        
        // Insert upstream block into nginx config
        await api.runSSHCommand(server, `
          sudo sed -i '/http {/r /tmp/${appName}-upstream.conf' /etc/nginx/nginx.conf || true
        `);
        
        await api.runSSHCommand(server, `sudo nginx -t && sudo systemctl reload nginx || true`);
        
        console.log(`✅ Updated nginx for ${cores} total containers on ${serverName}`);
      } catch (error) {
        console.log(`❌ Error updating nginx on ${serverName}:`, error.message);
      }
    })
  );
}

async function startWorkerContainers(api) {
  const config = api.getConfig();
  const servers = config.app.servers || {};
  const appName = config.app.name;
  
  console.log('🚀 Starting additional worker containers...');
  
  return Promise.all(
    Object.keys(servers).map(async serverName => {
      const server = config.servers[serverName];
      const instanceCount = getInstanceCount(config, serverName);
      const startingPort = getStartingPort(config, serverName);
      const cores = instanceCount === 'auto' ? await detectCores(api, serverName) : instanceCount;
      
      if (cores <= 1) {
        console.log(`📦 Single core detected on ${serverName}, no additional workers needed`);
        return;
      }
      
      try {
        // Stop existing worker containers (keep main container running)
        for (let i = 1; i <= 10; i++) {
          await api.runSSHCommand(server, `docker stop ${appName}-worker-${i} || true`);
          await api.runSSHCommand(server, `docker rm ${appName}-worker-${i} || true`);
        }
        
        console.log(`📦 Starting ${cores - 1} worker containers on ${serverName}...`);
        
        // Start worker containers (main container is already running via MUP)
        for (let i = 1; i < cores; i++) {
          const containerName = `${appName}-worker-${i}`;
          const port = startingPort + i - 1;
          
          // Copy the exact docker run command that MUP uses, but modify name and port
          // Add CORE_ID environment variable (main=0, workers=1,2,3...)
          const runCmd = `docker run -d \
            --name ${containerName} \
            --hostname ${serverName}-${appName}-${i} \
            --restart always \
            --network=bridge \
            -p 127.0.0.1:${port}:3000 \
            -e PORT=3000 \
            -e CORE_ID=${i} \
            --env-file /opt/${appName}/config/env.list \
            mup-${appName}:latest`;
          
          await api.runSSHCommand(server, runCmd);
          console.log(`✅ Started ${containerName} on port ${port} (core-${i})`);
        }
        
        // Show all containers status
        const status = await api.runSSHCommand(server, `docker ps | grep ${appName}`);
        console.log(`📊 Container Status:\n${status.output}`);
        
      } catch (error) {
        console.log(`❌ Error starting worker containers on ${serverName}:`, error.message);
      }
    })
  );
}

async function stopWorkerContainers(api) {
  const config = api.getConfig();
  const servers = config.app.servers || {};
  const appName = config.app.name;
  
  console.log('🛑 Stopping worker containers...');
  
  return Promise.all(
    Object.keys(servers).map(async serverName => {
      const server = config.servers[serverName];
      
      try {
        // Stop only worker containers, leave main container for MUP
        const workerList = await api.runSSHCommand(server, `docker ps -q --filter name=${appName}-worker`);
        if (workerList.output.trim()) {
          await api.runSSHCommand(server, `docker stop $(docker ps -q --filter name=${appName}-worker)`);
          await api.runSSHCommand(server, `docker rm $(docker ps -aq --filter name=${appName}-worker)`);
          console.log(`✅ Stopped worker containers on ${serverName}`);
        }
      } catch (error) {
        console.log(`❌ Error stopping worker containers on ${serverName}:`, error.message);
      }
    })
  );
}

async function restartWorkerContainers(api) {
  const config = api.getConfig();
  const servers = config.app.servers || {};
  const appName = config.app.name;
  
  console.log('🔄 Restarting worker containers...');
  
  return Promise.all(
    Object.keys(servers).map(async serverName => {
      const server = config.servers[serverName];
      
      try {
        // Restart worker containers
        const workerList = await api.runSSHCommand(server, `docker ps -aq --filter name=${appName}-worker`);
        if (workerList.output.trim()) {
          await api.runSSHCommand(server, `docker restart $(docker ps -aq --filter name=${appName}-worker)`);
          console.log(`✅ Restarted worker containers on ${serverName}`);
        } else {
          // If no workers exist, start them
          return startWorkerContainers(api);
        }
      } catch (error) {
        console.log(`❌ Error restarting worker containers on ${serverName}:`, error.message);
      }
    })
  );
}

// Custom logs command to aggregate logs from all containers
async function aggregateLogs(api) {
  const config = api.getConfig();
  const servers = config.app.servers || {};
  const appName = config.app.name;
  
  return Promise.all(
    Object.keys(servers).map(async serverName => {
      const server = config.servers[serverName];
      
      try {
        console.log(`📋 Logs from ${serverName}:`);
        
        // Get logs from main container
        const mainLogs = await api.runSSHCommand(server, `docker logs --tail=50 ${appName} 2>&1 || true`);
        if (mainLogs.output) {
          console.log(`\n=== ${appName} (main) ===`);
          console.log(mainLogs.output);
        }
        
        // Get logs from worker containers
        const workers = await api.runSSHCommand(server, `docker ps --filter name=${appName}-worker --format "{{.Names}}" || true`);
        if (workers.output.trim()) {
          const workerNames = workers.output.trim().split('\n');
          for (const workerName of workerNames) {
            const workerLogs = await api.runSSHCommand(server, `docker logs --tail=20 ${workerName} 2>&1 || true`);
            if (workerLogs.output) {
              console.log(`\n=== ${workerName} ===`);
              console.log(workerLogs.output);
            }
          }
        }
      } catch (error) {
        console.log(`❌ Error getting logs from ${serverName}:`, error.message);
      }
    })
  );
}

module.exports = {
  name: 'mup-multicore',
  description: 'Multi-container deployment for CPU core utilization (MUP compatible)',
  
  validate: {
    'multiCore'(config, utils) {
      const details = [];
      
      if (!config.multiCore) {
        return details;
      }
      
      const multiCore = config.multiCore;
      
      // Validate instances
      if (multiCore.instances !== undefined) {
        if (typeof multiCore.instances !== 'string' && typeof multiCore.instances !== 'number') {
          details.push({
            message: 'instances must be "auto" or a number',
            path: 'multiCore.instances'
          });
        } else if (typeof multiCore.instances === 'string' && multiCore.instances !== 'auto') {
          details.push({
            message: 'instances string value must be "auto"',
            path: 'multiCore.instances'
          });
        } else if (typeof multiCore.instances === 'number' && multiCore.instances < 1) {
          details.push({
            message: 'instances must be at least 1',
            path: 'multiCore.instances'
          });
        }
      }
      
      // Validate startingPort
      if (multiCore.startingPort !== undefined) {
        if (typeof multiCore.startingPort !== 'number') {
          details.push({
            message: 'startingPort must be a number',
            path: 'multiCore.startingPort'
          });
        } else if (multiCore.startingPort < 1024 || multiCore.startingPort > 65535) {
          details.push({
            message: 'startingPort must be between 1024 and 65535',
            path: 'multiCore.startingPort'
          });
        }
      }
      
      // Validate useNginx
      if (multiCore.useNginx !== undefined) {
        if (typeof multiCore.useNginx !== 'boolean') {
          details.push({
            message: 'useNginx must be a boolean',
            path: 'multiCore.useNginx'
          });
        }
      }
      
      return details;
    }
  },
  
  commands: {
    logs: {
      description: 'Show logs from all containers',
      handler: aggregateLogs
    }
  },
  
  hooks: {
    'post.default.deploy'(api) {
      const config = api.getConfig();
      if (config.app && config.app.docker) {
        // Check if any server needs nginx updates
        const servers = config.app.servers || {};
        const needsNginx = Object.keys(servers).some(serverName => shouldUseNginx(config, serverName));
        
        if (needsNginx) {
          return startWorkerContainers(api).then(() => updateMupNginx(api));
        } else {
          return startWorkerContainers(api);
        }
      }
    },
    
    'post.default.start'(api) {
      const config = api.getConfig();
      if (config.app && config.app.docker) {
        return startWorkerContainers(api);
      }
    },
    
    'post.default.restart'(api) {
      const config = api.getConfig();
      if (config.app && config.app.docker) {
        return restartWorkerContainers(api);
      }
    },
    
    'post.default.stop'(api) {
      const config = api.getConfig();
      if (config.app && config.app.docker) {
        return stopWorkerContainers(api);
      }
    }
  },
  
  prepareConfig(config) {
    // No build-time changes needed - this is all runtime
    return config;
  }
};