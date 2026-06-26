// storage.js — all Supabase interaction lives here
// The rest of the app calls these functions and never imports Supabase directly.

const SUPABASE_URL = 'https://iehieflvphilkxnecint.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Zivoqo988w2clrIrFdegVA_Jm8nZw8O'

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------

async function signIn(email) {
  const { error } = await db.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin }
  });
  if (error) throw error;
}

async function signOut() {
  const { error } = await db.auth.signOut();
  if (error) throw error;
}

async function getCurrentUser() {
  const { data: { user } } = await db.auth.getUser();
  return user; // null if not signed in
}

function onAuthChange(callback) {
  db.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });
}

// ---------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------

async function saveRoute(routeObject) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Not signed in');

  const row = {
    owner: user.id,
    name: routeObject.name,
    waypoints: routeObject.waypoints,
    distance_km: routeObject.distance_km,
    gain_m: routeObject.gain_m,
    geometry: routeObject.geometry ?? null,
  };

  const { data, error } = await db
    .from('routes')
    .insert(row)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function updateRoute(id, changes) {
  const { data, error } = await db
    .from('routes')
    .update(changes)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function listRoutes() {
  const { data, error } = await db
    .from('routes')
    .select('id, name, waypoints, distance_km, gain_m, geometry, created_at')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

async function deleteRoute(id) {
  const { error } = await db
    .from('routes')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

async function renameRoute(id, name) {
  return updateRoute(id, { name });
}
