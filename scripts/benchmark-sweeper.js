'use strict';

require('dotenv').config();
const { pool } = require('../src/config/db');
const attendanceSweeper = require('../src/services/attendanceSweeper');
const { toUtcDateTime, istCalendarDate } = require('../src/utils/time');

// 0. Safety Guard: local DB only
const dbHost = (process.env.DB_HOST || '').toLowerCase();
if (dbHost !== 'localhost' && dbHost !== '127.0.0.1') {
  console.error(`Refusing to run benchmark against DB_HOST "${dbHost}". Only localhost/127.0.0.1 is allowed.`);
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run benchmark in production NODE_ENV.');
  process.exit(1);
}

async function runBenchmark() {
  console.log('=== Sweeper 500-Record Benchmark & Concurrency Test ===\n');

  let officeId = null;
  const COUNT = 500;
  const userPrefix = 'tbtstswp';

  try {
    const now = new Date();
    const nowUtc = toUtcDateTime(now);
    const tenMinAgo = new Date(now.getTime() - 10 * 60000);
    const tenMinAgoUtc = toUtcDateTime(tenMinAgo);
    const today = istCalendarDate(now);

    // 1. Create Test Office
    const [offRes] = await pool.query(
      `INSERT INTO attendance_offices
        (name, lat, lng, radius_m, accuracy_max_m, ip_allowlist, require_both,
         shift_start, shift_end, grace_minutes, outside_tolerance_minutes,
         short_outing_allowance_minutes, heartbeat_seconds, reverify_count,
         created_at, updated_at)
       VALUES ('Swp Office', 12.9716, 77.5946, 200, 50, NULL, 0, '08:00:00', '22:00:00', 10, 10, 30, 60, 2, ?, ?)`,
      [nowUtc, nowUtc]
    );
    officeId = offRes.insertId;

    console.log(`Setting up ${COUNT} fixture open records...`);

    // Bulk insert records in batches of 100
    const recordIds = [];
    for (let batch = 0; batch < COUNT; batch += 100) {
      const recValues = [];
      for (let i = batch + 1; i <= batch + 100; i++) {
        const uid = `${userPrefix}${String(i).padStart(4, '0')}`;
        recValues.push(`('${uid}', '${today}', 'Benchmark User ${i}', ${officeId}, '${tenMinAgoUtc}', 'PRESENT', 0, '${nowUtc}', '${nowUtc}')`);
      }
      const [res] = await pool.query(
        `INSERT INTO attendance_records
          (user_id, attendance_date, fullname, office_id, check_in_at, status, worked_minutes, created_at, updated_at)
         VALUES ${recValues.join(', ')}`
      );
      for (let k = 0; k < 100; k++) {
        recordIds.push(res.insertId + k);
      }
    }

    // Bulk insert presence rows
    for (let batch = 0; batch < COUNT; batch += 100) {
      const presValues = [];
      const intvValues = [];
      for (let i = batch; i < batch + 100; i++) {
        const rid = recordIds[i];
        const uid = `${userPrefix}${String(i + 1).padStart(4, '0')}`;
        presValues.push(`(${rid}, '${uid}', 'INSIDE', '${tenMinAgoUtc}', '${tenMinAgoUtc}', 0, 0, '${nowUtc}')`);
        intvValues.push(`(${rid}, 'INSIDE', '${tenMinAgoUtc}')`);
      }
      await pool.query(
        `INSERT INTO attendance_presence (record_id, user_id, state, last_heartbeat_at, last_inside_at, outside_streak, weak_streak, updated_at)
         VALUES ${presValues.join(', ')}`
      );
      await pool.query(
        `INSERT INTO attendance_intervals (record_id, state, started_at)
         VALUES ${intvValues.join(', ')}`
      );
    }

    console.log(`✅ ${COUNT} open records created with presence and intervals.\n`);

    // 2. Benchmark sweepOnce()
    const origQuery = pool.query;
    let queryCount = 0;
    pool.query = function (...args) {
      queryCount++;
      return origQuery.apply(this, args);
    };

    console.log('Timing sweepOnce() on 500 open records...');
    const startTime = Date.now();
    const result = await attendanceSweeper.sweepOnce();
    const durationMs = Date.now() - startTime;
    pool.query = origQuery;

    console.log(`\n📊 Benchmark Results:`);
    console.log(`- Total Duration: ${durationMs} ms (${(durationMs / 1000).toFixed(2)} s)`);
    console.log(`- Total SQL Queries: ${queryCount}`);
    console.log(`- Queries per Record: ${(queryCount / COUNT).toFixed(2)}`);
    console.log(`- Actions:`, result);

    const withinTime = durationMs <= 5000;
    const withinQueryCap = queryCount <= COUNT * 6;

    console.log(`- Duration <= 5000ms: ${withinTime ? 'PASS' : 'FAIL'}`);
    console.log(`- Queries <= 6/record (${COUNT * 6}): ${withinQueryCap ? 'PASS' : 'FAIL'}`);

    // 3. Test Overlapping Sweeps & GET_LOCK Concurrency Guard
    console.log('\n--- Testing Overlapping Sweeps (GET_LOCK Concurrency Guard) ---');
    const lockConn = await pool.getConnection();
    try {
      // Hold lock on connection 1
      const [lockRes] = await lockConn.query("SELECT GET_LOCK('attendance_sweeper', 0) AS lock_acquired");
      const lockAcquired = lockRes[0]?.lock_acquired === 1;
      console.log(`Lock acquired on connection 1: ${lockAcquired}`);

      // Attempt sweepOnce on connection 2 (pool) - must detect lock held and skip
      const overlapResult = await attendanceSweeper.sweepOnce();
      console.log('Concurrent sweep result:', overlapResult);

      const passLock = overlapResult?.skipped === true && overlapResult?.reason === 'lock_held';
      console.log(`Concurrent sweep blocked cleanly: ${passLock ? 'PASS' : 'FAIL'}`);

      // Release lock
      await lockConn.query("SELECT RELEASE_LOCK('attendance_sweeper')");
    } finally {
      lockConn.release();
    }
  } finally {
    console.log('\nCleaning up benchmark fixtures...');
    try {
      await pool.query(`DELETE FROM attendance_intervals WHERE record_id IN (SELECT id FROM attendance_records WHERE user_id LIKE '${userPrefix}%')`);
      await pool.query(`DELETE FROM attendance_presence WHERE user_id LIKE '${userPrefix}%'`);
      await pool.query(`DELETE FROM attendance_reverify_tasks WHERE user_id LIKE '${userPrefix}%'`);
      await pool.query(`DELETE FROM attendance_records WHERE user_id LIKE '${userPrefix}%'`);
      if (officeId) {
        await pool.query('DELETE FROM attendance_offices WHERE id = ?', [officeId]);
      }
      console.log('✅ Cleanup complete.');
    } catch (e) {
      console.error('Cleanup error:', e.message);
    }
    await pool.end();
  }
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
