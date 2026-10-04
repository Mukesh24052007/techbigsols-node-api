'use strict';

const EventEmitter = require('events');

class AttendanceBus {
  constructor() {
    this._emitter = new EventEmitter();
    // Allow multiple subscribers across controllers/sweepers/SSE
    this._emitter.setMaxListeners(100);
  }

  /**
   * Emits an attendance domain event.
   * Payloads contain employee id, name, time, and type only (no coordinates, no embeddings).
   *
   * @param {string} type - 'checkin' | 'reverify' | 'left_premises' | 'returned' | 'auto_checkout' | 'violation'
   * @param {Object} payload
   * @param {string} payload.employeeId
   * @param {string} payload.name
   * @param {string|Date} payload.time
   * @param {string} [payload.reason] - For left_premises ('left'|'no_signal'|'weak_gps') or violation
   */
  emit(type, payload = {}) {
    const sanitized = {
      type,
      employeeId: payload.employeeId || payload.userId || payload.user_id,
      name: payload.name || payload.fullname || 'Employee',
      time: payload.time ? (typeof payload.time === 'string' ? payload.time : payload.time.toISOString()) : new Date().toISOString(),
      ...(payload.reason ? { reason: payload.reason } : {}),
      ...(payload.kind ? { kind: payload.kind } : {}),
    };

    // Strip any accidental sensitive data
    delete sanitized.lat;
    delete sanitized.lng;
    delete sanitized.accuracy;
    delete sanitized.descriptors;
    delete sanitized.descriptor;
    delete sanitized.face_template;

    this._emitter.emit('attendance_event', sanitized);
    this._emitter.emit(`attendance:${type}`, sanitized);
  }

  /**
   * Subscribes to attendance events.
   * @param {Function} fn - Listener callback receiving sanitized payload
   * @returns {Function} Unsubscribe function
   */
  subscribe(fn) {
    this._emitter.on('attendance_event', fn);
    return () => {
      this._emitter.off('attendance_event', fn);
    };
  }
}

const attendanceBus = new AttendanceBus();

module.exports = attendanceBus;
