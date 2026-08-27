export interface Env {
    cms_assets: R2Bucket;
    cms_db: D1Database;
}

// Columns on the `events` table, excluding `id`. Shared by create/update/delete
// so the insert/select/diff logic all agree on the same shape.
const EVENT_COLUMNS = [
    'event_name', 'club_name', 'event_type', 'event_for', 'poster_path',
    'start_date_time', 'end_date_time', 'price_per_person', 'participation_type',
    'event_venue', 'short_description', 'long_description', 'is_special_event',
    'registration_link', 'team_size', 'faculty_coord_emp_id', 'faculty_coord_name',
    'faculty_coord_mobile', 'faculty_coord_email',
] as const;

interface Actor {
    id: string | null;
    name: string | null;
    email: string | null;
}

function decodeHeader(value: string | null): string | null {
    if (!value) return null;
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function getActor(request: Request): Actor {
    return {
        id: request.headers.get('X-User-Id'),
        name: decodeHeader(request.headers.get('X-User-Name')),
        email: decodeHeader(request.headers.get('X-User-Email')),
    };
}

async function logActivity(env: Env, entry: {
    entity_type: string;
    entity_id: number;
    entity_name?: string | null;
    action: 'create' | 'update' | 'delete' | 'restore';
    changes?: unknown;
    actor: Actor;
}) {
    await env.cms_db.prepare(
        `INSERT INTO activity_logs (entity_type, entity_id, entity_name, action, changes, actor_id, actor_name, actor_email)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
        entry.entity_type,
        entry.entity_id,
        entry.entity_name ?? null,
        entry.action,
        entry.changes !== undefined ? JSON.stringify(entry.changes) : null,
        entry.actor.id ?? null,
        entry.actor.name ?? null,
        entry.actor.email ?? null,
    ).run();
}

// Diffs the fields in `data` against the current row, returning only the
// fields that actually changed as { field: { old, new } }.
function diffEvent(oldRow: Record<string, unknown>, data: Record<string, unknown>) {
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const col of EVENT_COLUMNS) {
        const oldVal = oldRow[col] ?? null;
        const newVal = data[col] ?? null;
        if (oldVal !== newVal) {
            changes[col] = { old: oldVal, new: newVal };
        }
    }
    return changes;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // --- CORS Handling ---
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Range, X-User-Id, X-User-Name, X-User-Email',
                },
            });
        }
        const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

        // --- Route 1: Serve Assets (Images/Videos) ---
        if (request.method === 'GET' && (url.pathname.startsWith('/images/') || url.pathname.startsWith('/videos/'))) {
            const hasRange = request.headers.has('range');

            // Full-object requests (the common case — poster thumbnails, modal
            // previews) are cached at Cloudflare's edge so repeat views of the
            // same asset never touch R2 or this Worker again. Range requests
            // (video seeking) always go straight to R2 since we can't safely
            // slice a cached entry.
            if (!hasRange) {
                const cached = await caches.default.match(request);
                if (cached) return cached;
            }

            const key = decodeURIComponent(url.pathname.slice(1));

            // R2 parses the Range header itself, so a single get() covers both
            // full and ranged reads — no separate head() call needed for size.
            const object = await env.cms_assets.get(key, {
                range: hasRange ? request.headers : undefined,
            });
            if (!object) return new Response('File Not Found', { status: 404, headers: corsHeaders });

            const headers = new Headers(corsHeaders);
            object.writeHttpMetadata(headers);
            headers.set('etag', object.httpEtag);
            headers.set('accept-ranges', 'bytes');
            headers.set('cache-control', 'public, max-age=31536000, immutable');

            if (object.range) {
                const { offset = 0, length = object.size - offset } = object.range as { offset?: number; length?: number };
                headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
                headers.set('Content-Length', length.toString());
                return new Response(object.body, { headers, status: 206 });
            }

            const response = new Response(object.body, { headers });
            if (!hasRange) {
                ctx.waitUntil(caches.default.put(request, response.clone()));
            }
            return response;
        }

        // --- Route 2: Events API (Kept the NEW Schema logic so forms work) ---

        // GET Events
        if (request.method === 'GET' && url.pathname === '/events') {
            try {
                const { results } = await env.cms_db.prepare('SELECT * FROM events ORDER BY start_date_time ASC').all();
                return Response.json(results, { headers: corsHeaders });
            } catch (err) {
                return Response.json({ error: 'Fetch failed', details: String(err) }, { status: 500, headers: corsHeaders });
            }
        }

        // GET Single Event
        if (request.method === 'GET' && url.pathname.startsWith('/events/') && url.pathname !== '/events') {
            const id = url.pathname.split('/').pop();
            try {
                const event = await env.cms_db.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
                if (!event) return new Response(JSON.stringify({ error: 'Event not found' }), { status: 404, headers: corsHeaders });
                return Response.json(event, { headers: corsHeaders });
            } catch (err) {
                return Response.json({ error: 'Fetch failed' }, { status: 500, headers: corsHeaders });
            }
        }

        // POST Create Event (JSON)
        if (request.method === 'POST' && url.pathname === '/events') {
            try {
                const data = await request.json() as any;
                const query = `
                    INSERT INTO events (
                        event_name, club_name, event_type, event_for, poster_path,
                        start_date_time, end_date_time, price_per_person, participation_type,
                        event_venue, short_description, long_description, is_special_event,
                        registration_link, team_size, faculty_coord_emp_id, faculty_coord_name,
                        faculty_coord_mobile, faculty_coord_email
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `;
                const result = await env.cms_db.prepare(query).bind(
                    data.event_name ?? null, data.club_name ?? null, data.event_type ?? null, data.event_for ?? null, data.poster_path ?? null,
                    data.start_date_time ?? null, data.end_date_time ?? null, data.price_per_person ?? null, data.participation_type ?? null,
                    data.event_venue ?? null, data.short_description ?? null, data.long_description ?? null, data.is_special_event ?? null,
                    data.registration_link ?? null, data.team_size ?? null, data.faculty_coord_emp_id ?? null, data.faculty_coord_name ?? null,
                    data.faculty_coord_mobile ?? null, data.faculty_coord_email ?? null
                ).run();

                const newId = result.meta.last_row_id as number;
                ctx.waitUntil(logActivity(env, {
                    entity_type: 'event',
                    entity_id: newId,
                    entity_name: data.event_name ?? null,
                    action: 'create',
                    changes: { after: data },
                    actor: getActor(request),
                }));

                return Response.json({ success: true, id: newId }, { headers: corsHeaders });
            } catch (err) {
                return Response.json({ error: 'Create failed', details: String(err) }, { status: 500, headers: corsHeaders });
            }
        }

        // PUT Update Event (JSON)
        if (request.method === 'PUT' && url.pathname.startsWith('/events/')) {
            const id = url.pathname.split('/').pop();
            try {
                const data = await request.json() as any;

                const existing = await env.cms_db.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<Record<string, unknown>>();
                if (!existing) return Response.json({ error: 'Event not found' }, { status: 404, headers: corsHeaders });

                const query = `
                    UPDATE events SET
                        event_name = ?, club_name = ?, event_type = ?, event_for = ?, poster_path = ?,
                        start_date_time = ?, end_date_time = ?, price_per_person = ?, participation_type = ?,
                        event_venue = ?, short_description = ?, long_description = ?, is_special_event = ?,
                        registration_link = ?, team_size = ?, faculty_coord_emp_id = ?, faculty_coord_name = ?,
                        faculty_coord_mobile = ?, faculty_coord_email = ?
                    WHERE id = ?
                `;
                await env.cms_db.prepare(query).bind(
                    data.event_name ?? null, data.club_name ?? null, data.event_type ?? null, data.event_for ?? null, data.poster_path ?? null,
                    data.start_date_time ?? null, data.end_date_time ?? null, data.price_per_person ?? null, data.participation_type ?? null,
                    data.event_venue ?? null, data.short_description ?? null, data.long_description ?? null, data.is_special_event ?? null,
                    data.registration_link ?? null, data.team_size ?? null, data.faculty_coord_emp_id ?? null, data.faculty_coord_name ?? null,
                    data.faculty_coord_mobile ?? null, data.faculty_coord_email ?? null, id
                ).run();

                const changes = diffEvent(existing, data);
                if (Object.keys(changes).length > 0) {
                    ctx.waitUntil(logActivity(env, {
                        entity_type: 'event',
                        entity_id: Number(id),
                        entity_name: (data.event_name ?? existing.event_name) as string | null,
                        action: 'update',
                        changes,
                        actor: getActor(request),
                    }));
                }

                return Response.json({ success: true }, { headers: corsHeaders });
            } catch (err) {
                return Response.json({ error: 'Update failed', details: String(err) }, { status: 500, headers: corsHeaders });
            }
        }

        // DELETE Event (soft delete: moves the row into `deleted_events` so it can be undone)
        if (request.method === 'DELETE' && url.pathname.startsWith('/events/')) {
            const id = url.pathname.split('/').pop();
            try {
                const event = await env.cms_db.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<Record<string, unknown>>();
                if (!event) return Response.json({ error: 'Event not found' }, { status: 404, headers: corsHeaders });

                const actor = getActor(request);

                await env.cms_db.prepare(
                    `INSERT INTO deleted_events (
                        id, event_name, club_name, event_type, event_for, poster_path,
                        start_date_time, end_date_time, price_per_person, participation_type,
                        event_venue, short_description, long_description, is_special_event,
                        registration_link, team_size, faculty_coord_emp_id, faculty_coord_name,
                        faculty_coord_mobile, faculty_coord_email,
                        deleted_by_id, deleted_by_name, deleted_by_email
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).bind(
                    event.id, event.event_name, event.club_name, event.event_type, event.event_for, event.poster_path,
                    event.start_date_time, event.end_date_time, event.price_per_person, event.participation_type,
                    event.event_venue, event.short_description, event.long_description, event.is_special_event,
                    event.registration_link, event.team_size, event.faculty_coord_emp_id, event.faculty_coord_name,
                    event.faculty_coord_mobile, event.faculty_coord_email,
                    actor.id, actor.name, actor.email,
                ).run();

                await env.cms_db.prepare('DELETE FROM events WHERE id = ?').bind(id).run();

                ctx.waitUntil(logActivity(env, {
                    entity_type: 'event',
                    entity_id: Number(id),
                    entity_name: event.event_name as string | null,
                    action: 'delete',
                    changes: { snapshot: event },
                    actor,
                }));

                return Response.json({ success: true }, { headers: corsHeaders });
            } catch (err) {
                return Response.json({ error: 'Delete failed', details: String(err) }, { status: 500, headers: corsHeaders });
            }
        }

        // --- Route 2b: Activity Log API ---

        // GET Activity Log
        if (request.method === 'GET' && url.pathname === '/activity-logs') {
            try {
                const limitParam = Number(url.searchParams.get('limit'));
                const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;
                const entityType = url.searchParams.get('entity_type');
                const entityId = url.searchParams.get('entity_id');
                const action = url.searchParams.get('action');

                const conditions: string[] = [];
                const bindings: unknown[] = [];
                if (entityType) { conditions.push('entity_type = ?'); bindings.push(entityType); }
                if (entityId) { conditions.push('entity_id = ?'); bindings.push(entityId); }
                if (action) { conditions.push('action = ?'); bindings.push(action); }

                const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
                const query = `SELECT * FROM activity_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`;
                const { results } = await env.cms_db.prepare(query).bind(...bindings, limit).all();

                return Response.json(results, { headers: corsHeaders });
            } catch (err) {
                return Response.json({ error: 'Fetch failed', details: String(err) }, { status: 500, headers: corsHeaders });
            }
        }

        // POST Undo a deletion
        if (request.method === 'POST' && /^\/activity-logs\/\d+\/undo$/.test(url.pathname)) {
            const logId = url.pathname.split('/')[2];
            try {
                const log = await env.cms_db.prepare('SELECT * FROM activity_logs WHERE id = ?').bind(logId).first<Record<string, unknown>>();
                if (!log) return Response.json({ error: 'Activity log entry not found' }, { status: 404, headers: corsHeaders });
                if (log.action !== 'delete') return Response.json({ error: 'Only deletions can be undone' }, { status: 400, headers: corsHeaders });
                if (log.undone) return Response.json({ error: 'This deletion has already been undone' }, { status: 400, headers: corsHeaders });

                const deletedEvent = await env.cms_db.prepare('SELECT * FROM deleted_events WHERE id = ?').bind(log.entity_id).first<Record<string, unknown>>();
                if (!deletedEvent) return Response.json({ error: 'Deleted event data no longer available' }, { status: 404, headers: corsHeaders });

                const alreadyExists = await env.cms_db.prepare('SELECT id FROM events WHERE id = ?').bind(log.entity_id).first();
                if (alreadyExists) return Response.json({ error: 'An event with this id already exists' }, { status: 409, headers: corsHeaders });

                await env.cms_db.prepare(
                    `INSERT INTO events (
                        id, event_name, club_name, event_type, event_for, poster_path,
                        start_date_time, end_date_time, price_per_person, participation_type,
                        event_venue, short_description, long_description, is_special_event,
                        registration_link, team_size, faculty_coord_emp_id, faculty_coord_name,
                        faculty_coord_mobile, faculty_coord_email
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).bind(
                    deletedEvent.id, deletedEvent.event_name, deletedEvent.club_name, deletedEvent.event_type, deletedEvent.event_for, deletedEvent.poster_path,
                    deletedEvent.start_date_time, deletedEvent.end_date_time, deletedEvent.price_per_person, deletedEvent.participation_type,
                    deletedEvent.event_venue, deletedEvent.short_description, deletedEvent.long_description, deletedEvent.is_special_event,
                    deletedEvent.registration_link, deletedEvent.team_size, deletedEvent.faculty_coord_emp_id, deletedEvent.faculty_coord_name,
                    deletedEvent.faculty_coord_mobile, deletedEvent.faculty_coord_email,
                ).run();

                await env.cms_db.prepare('DELETE FROM deleted_events WHERE id = ?').bind(log.entity_id).run();
                await env.cms_db.prepare('UPDATE activity_logs SET undone = 1 WHERE id = ?').bind(logId).run();

                const actor = getActor(request);
                ctx.waitUntil(logActivity(env, {
                    entity_type: 'event',
                    entity_id: log.entity_id as number,
                    entity_name: deletedEvent.event_name as string | null,
                    action: 'restore',
                    changes: { restored_from_log_id: Number(logId) },
                    actor,
                }));

                return Response.json({ success: true }, { headers: corsHeaders });
            } catch (err) {
                return Response.json({ error: 'Undo failed', details: String(err) }, { status: 500, headers: corsHeaders });
            }
        }

        // --- Route 3: Media Library API (RESTORED FROM ORIGINAL) ---

        // GET List of Files
        if (request.method === 'GET' && url.pathname === '/media') {
            const prefix = url.searchParams.get('prefix') || '';
            const list = await env.cms_assets.list({ prefix: prefix, limit: 100 });

            const files = list.objects.map(obj => ({
                key: obj.key,
                url: `/${obj.key}`,
                uploaded: obj.uploaded,
                size: obj.size
            }));

            return Response.json(files, { headers: corsHeaders });
        }

        // POST Upload Standalone File
        if (request.method === 'POST' && (url.pathname === '/media' || url.pathname === '/media/upload')) {
             try {
                const formData = await request.formData();
                const file = formData.get('file');
                const targetFolder = formData.get('folder') as string;

                if (!(file instanceof File)) return new Response('No file', { status: 400, headers: corsHeaders });

                let keyPrefix = 'images/photos/';
                if (targetFolder === 'videos' || file.type.startsWith('video/')) {
                    keyPrefix = 'videos/';
                }

                // Sanitize filename
                const safeName = file.name.replace(/\s+/g, '-');
                const fileName = `${crypto.randomUUID()}-${safeName}`;
                const key = `${keyPrefix}${fileName}`;

                await env.cms_assets.put(key, file);

                return Response.json({ success: true, key: key, url: `/${key}` }, { headers: corsHeaders });
             } catch (e) {
                 return Response.json({ error: String(e) }, { status: 500, headers: corsHeaders });
             }
        }

        // DELETE Standalone Media
        if (request.method === 'DELETE' && url.pathname === '/media') {
            const urlParams = new URLSearchParams(url.search);
            const key = urlParams.get('key');

            if (key) {
                await env.cms_assets.delete(key);
                return Response.json({ success: true }, { headers: corsHeaders });
            }
            return new Response('Missing key', { status: 400, headers: corsHeaders });
        }

        return new Response('CMS API Running', { headers: corsHeaders });
    },
};
