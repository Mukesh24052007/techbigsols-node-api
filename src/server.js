require('dotenv').config();
const app = require('./app');
const { testConnection, pool } = require('./config/db');
const attendanceSweeper = require('./services/attendanceSweeper');

const PORT = process.env.PORT || 3000;

const start = async () => {
  await testConnection();

  const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  try {
    attendanceSweeper.start();
  } catch (err) {
    console.warn('⚠️  Failed to start attendance sweeper:', err.message);
  }

  // Graceful shutdown — close HTTP server then DB pool
  const shutdown = async (signal) => {
    console.log(`\n${signal} received. Shutting down gracefully…`);
    try {
      attendanceSweeper.stop();
    } catch (err) {
      console.warn('⚠️  Error stopping attendance sweeper:', err.message);
    }
    server.close(async () => {
      try {
        await pool.end();
        console.log('✅ Database pool closed');
      } catch (err) {
        console.error('⚠️  Error closing DB pool:', err.message);
      }
      console.log('👋 Process exiting');
      process.exit(0);
    });

    // Force-kill if graceful shutdown takes too long.
    // AWS ECS / Elastic Beanstalk default SIGTERM window is 30 s.
    setTimeout(() => {
      console.error('❌ Graceful shutdown timed out. Forcing exit.');
      process.exit(1);
    }, 25_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
    shutdown('unhandledRejection');
  });
};

start();
