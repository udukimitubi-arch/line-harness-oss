import { validateMessageContent } from '@line-crm/shared';
import { Hono } from 'hono';
import {
  getReminders,
  getReminderById,
  createReminder,
  updateReminder,
  deleteReminder,
  getReminderSteps,
  createReminderStep,
  isValidReminderSendTime,
  deleteReminderStep,
  enrollFriendInReminder,
  getFriendReminders,
  cancelFriendReminder,
} from '@line-crm/db';
import type { Env } from '../index.js';

const reminders = new Hono<Env>();

// ========== リマインダCRUD ==========

reminders.get('/api/reminders', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    let items: Awaited<ReturnType<typeof getReminders>>;
    if (lineAccountId) {
      const result = await c.env.DB
        .prepare(`SELECT * FROM reminders WHERE line_account_id = ? ORDER BY created_at DESC`)
        .bind(lineAccountId)
        .all();
      items = result.results as unknown as Awaited<ReturnType<typeof getReminders>>;
    } else {
      items = await getReminders(c.env.DB);
    }
    return c.json({
      success: true,
      data: items.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        isActive: Boolean(r.is_active),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/reminders error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.get('/api/reminders/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const [reminder, steps] = await Promise.all([
      getReminderById(c.env.DB, id),
      getReminderSteps(c.env.DB, id),
    ]);
    if (!reminder) return c.json({ success: false, error: 'Reminder not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: reminder.id,
        name: reminder.name,
        description: reminder.description,
        isActive: Boolean(reminder.is_active),
        createdAt: reminder.created_at,
        updatedAt: reminder.updated_at,
        steps: steps.map((s) => ({
          id: s.id,
          reminderId: s.reminder_id,
          offsetMinutes: s.offset_minutes,
          offsetDays: s.offset_days ?? null,
          sendTime: s.send_time ?? null,
          messageType: s.message_type,
          messageContent: s.message_content,
          createdAt: s.created_at,
        })),
      },
    });
  } catch (err) {
    console.error('GET /api/reminders/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.post('/api/reminders', async (c) => {
  try {
    const body = await c.req.json<{ name: string; description?: string; lineAccountId?: string | null }>();
    if (!body.name) return c.json({ success: false, error: 'name is required' }, 400);
    const item = await createReminder(c.env.DB, body);
    // Save line_account_id if provided
    if (body.lineAccountId) {
      await c.env.DB.prepare(`UPDATE reminders SET line_account_id = ? WHERE id = ?`)
        .bind(body.lineAccountId, item.id).run();
    }
    return c.json({ success: true, data: { id: item.id, name: item.name, createdAt: item.created_at } }, 201);
  } catch (err) {
    console.error('POST /api/reminders error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.put('/api/reminders/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    await updateReminder(c.env.DB, id, body);
    const updated = await getReminderById(c.env.DB, id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: { id: updated.id, name: updated.name, isActive: Boolean(updated.is_active) } });
  } catch (err) {
    console.error('PUT /api/reminders/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.delete('/api/reminders/:id', async (c) => {
  try {
    await deleteReminder(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/reminders/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== リマインダステップ ==========

reminders.post('/api/reminders/:id/steps', async (c) => {
  try {
    const reminderId = c.req.param('id');
    const body = await c.req.json<{
      offsetMinutes?: number;
      offsetDays?: number | null;
      sendTime?: string | null;
      messageType: string;
      messageContent: string;
    }>();
    // 送る時刻は「基準時刻から offsetMinutes 分」か「offsetDays 日前の sendTime（HH:MM）」のどちらか。
    const scheduled = body.sendTime !== undefined && body.sendTime !== null && body.sendTime !== '';
    if (scheduled && !isValidReminderSendTime(body.sendTime)) {
      return c.json({ success: false, error: 'sendTime must be HH:MM' }, 400);
    }
    if (scheduled && body.offsetDays !== undefined && body.offsetDays !== null
      && (!Number.isInteger(body.offsetDays) || body.offsetDays < 0 || body.offsetDays > 365)) {
      return c.json({ success: false, error: 'offsetDays must be an integer between 0 and 365' }, 400);
    }
    if ((!scheduled && body.offsetMinutes === undefined) || !body.messageType || !body.messageContent) {
      return c.json({ success: false, error: 'offsetMinutes (or sendTime), messageType, messageContent are required' }, 400);
    }
    const contentError = validateMessageContent(body.messageType, body.messageContent);
    if (contentError) return c.json({ success: false, error: contentError }, 400);
    const step = await createReminderStep(c.env.DB, {
      reminderId,
      offsetMinutes: body.offsetMinutes ?? 0,
      offsetDays: scheduled ? body.offsetDays ?? 0 : null,
      sendTime: scheduled ? body.sendTime : null,
      messageType: body.messageType,
      messageContent: body.messageContent,
    });
    return c.json({
      success: true,
      data: { id: step.id, reminderId: step.reminder_id, offsetMinutes: step.offset_minutes, offsetDays: step.offset_days ?? null, sendTime: step.send_time ?? null, messageType: step.message_type, createdAt: step.created_at },
    }, 201);
  } catch (err) {
    console.error('POST /api/reminders/:id/steps error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.delete('/api/reminders/:reminderId/steps/:stepId', async (c) => {
  try {
    await deleteReminderStep(c.env.DB, c.req.param('stepId'));
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/reminders/:reminderId/steps/:stepId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 友だちリマインダ登録 ==========

reminders.post('/api/reminders/:id/enroll/:friendId', async (c) => {
  try {
    const reminderId = c.req.param('id');
    const friendId = c.req.param('friendId');
    const body = await c.req.json<{ targetDate: string }>();
    if (!body.targetDate) return c.json({ success: false, error: 'targetDate is required' }, 400);
    const enrollment = await enrollFriendInReminder(c.env.DB, { friendId, reminderId, targetDate: body.targetDate });
    return c.json({
      success: true,
      data: { id: enrollment.id, friendId: enrollment.friend_id, reminderId: enrollment.reminder_id, targetDate: enrollment.target_date, status: enrollment.status },
    }, 201);
  } catch (err) {
    console.error('POST /api/reminders/:id/enroll/:friendId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.get('/api/friends/:friendId/reminders', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const items = await getFriendReminders(c.env.DB, friendId);
    return c.json({
      success: true,
      data: items.map((fr) => ({
        id: fr.id,
        friendId: fr.friend_id,
        reminderId: fr.reminder_id,
        targetDate: fr.target_date,
        status: fr.status,
        createdAt: fr.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/friends/:friendId/reminders error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.delete('/api/friend-reminders/:id', async (c) => {
  try {
    await cancelFriendReminder(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/friend-reminders/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { reminders };
