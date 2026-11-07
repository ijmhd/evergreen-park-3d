const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
export function upgradeLevel(facility, id) {
  if (!facility.restored) return 0;
  const value = facility.upgrades?.[id];
  return clamp(Number(typeof value === 'object' ? value?.level : value) || 0, 0, 5);
}

const TYPES = { count: 'capacity', seats: 'capacity', height: 'support', length: 'route', width: 'platform', speed: 'gates', theme: 'flags', effect: 'lights', comfort: 'shelter', efficiency: 'energy' };
const SLOTS = [[-8.85, -5.9], [-8.85, -2.3], [-8.85, 1.3], [8.85, -5.9], [8.85, -2.3], [8.85, 1.3]];
export function upgradeAppearance(facility) {
  const get = id => upgradeLevel(facility, id);
  const branches = (facility.branches || Object.keys(facility.upgrades || {}).map(id => ({ id }))).filter(b => b.id !== 'normalQueue' && b.id !== 'fastQueue');
  const modules = branches.map((branch, index) => {
    const level = get(branch.id);
    const type = TYPES[branch.id] || TYPES[branch.kind] || 'flags';
    const [x, z] = SLOTS[index % SLOTS.length];
    return { id: branch.id, type, level, x, z, width: 1.4, depth: 3.1, units: type === 'capacity' || type === 'lights' ? level * 2 : level };
  }).filter(module => module.level > 0);
  return {
    modules,
    metrics: {
      carouselHorses: 6 + get('count') * 3,
      carouselRadius: 4.6 + get('length') * 0.32,
      carouselHeight: 5.3 + get('height') * 0.45,
      ferrisCabins: 8 + get('count') * 2,
      ferrisRadius: 5.1 + get('height') * 0.5,
      coasterCars: 2 + get('length'),
      coasterCarWidth: 1.25 + get('width') * 0.22,
      animationFactor: 1 + get('speed') * 0.18,
      hullLength: 0.82 + get('length') * 0.065,
      hullWidth: 2.3 + get('width') * 0.25,
    },
    queues: [
      { id: 'normalQueue', level: get('normalQueue'), x: -5.1, width: 5.3 + get('normalQueue') * 0.5, depth: 2.5 + get('normalQueue') * 0.22, rails: 2 + get('normalQueue'), color: '#4b9b91', floorColor: '#bfdccd' },
      { id: 'fastQueue', level: get('fastQueue'), x: 5.5, width: 2.3 + get('fastQueue') * 0.38, depth: 2.5 + get('fastQueue') * 0.22, rails: 2 + get('fastQueue'), color: '#dda83f', floorColor: '#f2dea0' },
    ],
    totalLevel: branches.reduce((sum, b) => sum + get(b.id), 0) + get('normalQueue') + get('fastQueue'),
  };
}
