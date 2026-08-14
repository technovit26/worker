export interface Env {
    cms_assets: R2Bucket;
    cms_db: D1Database;
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
                    'Access-Control-Allow-Headers': 'Content-Type, Range',
                },
            });
        }
        const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

        // --- Route 1: Serve Assets (Images/Videos) ---
        if (request.method === 'GET' && (url.pathname.startsWith('/images/') || url.pathname.startsWith('/videos/'))) {
            const key = decodeURIComponent(url.pathname.slice(1));

            // 1. Get file metadata
            const objectHead = await env.cms_assets.head(key);
            if (!objectHead) return new Response('File Not Found', { status: 404, headers: corsHeaders });

            // 2. Handle Range Requests (Video Streaming)
            const rangeHeader = request.headers.get('range');
            const range = rangeHeader ? parseRange(rangeHeader, objectHead.size) : undefined;

            const object = await env.cms_assets.get(key, {
                range: range ? { offset: range.offset, length: range.length } : undefined
            });

            if (!object) return new Response('File Not Found', { status: 404, headers: corsHeaders });

            const headers = new Headers(corsHeaders);
            object.writeHttpMetadata(headers);
            headers.set('etag', object.httpEtag);

            if (range) {
                headers.set('Content-Range', `bytes ${range.offset}-${range.end}/${objectHead.size}`);
                headers.set('Content-Length', range.length.toString());
                return new Response(object.body, { headers, status: 206 });
            }

            return new Response(object.body, { headers });
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
                    data.event_name, data.club_name, data.event_type, data.event_for, data.poster_path,
                    data.start_date_time, data.end_date_time, data.price_per_person, data.participation_type,
                    data.event_venue, data.short_description, data.long_description, data.is_special_event,
                    data.registration_link, data.team_size, data.faculty_coord_emp_id, data.faculty_coord_name,
                    data.faculty_coord_mobile, data.faculty_coord_email
                ).run();
                return Response.json({ success: true, id: result.meta.last_row_id }, { headers: corsHeaders });
            } catch (err) {
                return Response.json({ error: 'Create failed', details: String(err) }, { status: 500, headers: corsHeaders });
            }
        }

        // PUT Update Event (JSON)
        if (request.method === 'PUT' && url.pathname.startsWith('/events/')) {
            const id = url.pathname.split('/').pop();
            try {
                const data = await request.json() as any;
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
                    data.event_name, data.club_name, data.event_type, data.event_for, data.poster_path,
                    data.start_date_time, data.end_date_time, data.price_per_person, data.participation_type,
                    data.event_venue, data.short_description, data.long_description, data.is_special_event,
                    data.registration_link, data.team_size, data.faculty_coord_emp_id, data.faculty_coord_name,
                    data.faculty_coord_mobile, data.faculty_coord_email, id
                ).run();
                return Response.json({ success: true }, { headers: corsHeaders });
            } catch (err) {
                return Response.json({ error: 'Update failed', details: String(err) }, { status: 500, headers: corsHeaders });
            }
        }

        // DELETE Event
        if (request.method === 'DELETE' && url.pathname.startsWith('/events/')) {
            const id = url.pathname.split('/').pop();
            try {
                const event: any = await env.cms_db.prepare('SELECT poster_path FROM events WHERE id = ?').bind(id).first();
                if (event && event.poster_path) {
                    ctx.waitUntil(env.cms_assets.delete(event.poster_path));
                }
                await env.cms_db.prepare('DELETE FROM events WHERE id = ?').bind(id).run();
                return Response.json({ success: true }, { headers: corsHeaders });
            } catch (err) {
                return Response.json({ error: 'Delete failed' }, { status: 500, headers: corsHeaders });
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

// Helper for video ranges
function parseRange(header: string, totalSize: number) {
    if (!header || !header.startsWith('bytes=')) return undefined;
    const parts = header.replace('bytes=', '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
    const chunkSize = end - start + 1;
    return { offset: start, length: chunkSize, end: end };
}
