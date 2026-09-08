export type TransitionCategory = 'Basic' | 'Film' | 'Camera' | 'Motion' | 'Light' | 'Glitch' | '3D'
export type TransitionDirection = 'left' | 'right' | 'up' | 'down'
export type TransitionEasing = 'linear' | 'smooth' | 'cinematic'

export const TRANSITION_LIBRARY = [
  { type: 'none', name: 'Cut', short: 'CUT', category: 'Basic', family: 'cut', description: 'قطع مباشر بدون مزج.' },
  { type: 'fade', name: 'Cross Fade', short: 'FD', category: 'Basic', family: 'fade', description: 'مزج نظيف ومتوازن بين اللقطتين.' },
  { type: 'dissolve', name: 'Dissolve', short: 'DS', category: 'Basic', family: 'fade', description: 'Dissolve كلاسيكي مناسب لمعظم المونتاج.' },

  { type: 'fadeblack', name: 'Fade Black', short: 'BK', category: 'Film', family: 'film', description: 'انتقال سينمائي عبر الأسود.' },
  { type: 'fadewhite', name: 'Fade White', short: 'WT', category: 'Film', family: 'light', description: 'وميض أبيض ناعم بين اللقطات.' },
  { type: 'fadegrays', name: 'Fade Grays', short: 'GY', category: 'Film', family: 'film', description: 'تحول لوني رمادي بطابع درامي.' },
  { type: 'hblur', name: 'Film Blur', short: 'BL', category: 'Film', family: 'blur', description: 'Blur أفقي احترافي بين المشاهد.' },
  { type: 'fadefast', name: 'Fast Fade', short: 'FF', category: 'Film', family: 'fade', description: 'Fade سريع للمونتاج الإيقاعي.' },
  { type: 'fadeslow', name: 'Slow Fade', short: 'SF', category: 'Film', family: 'fade', description: 'Fade هادئ للمشاهد العاطفية والسينمائية.' },

  { type: 'zoomin', name: 'Camera Zoom', short: 'ZM', category: 'Camera', family: 'camera', description: 'اندفاع كاميرا Zoom إلى اللقطة التالية.' },
  { type: 'radial', name: 'Radial', short: 'RD', category: 'Camera', family: 'camera', description: 'كشف دائري ديناميكي من المركز.' },
  { type: 'circlecrop', name: 'Circle Crop', short: 'CC', category: 'Camera', family: 'camera', description: 'Crop دائري يفتح المشهد التالي.' },
  { type: 'rectcrop', name: 'Rect Crop', short: 'RC', category: 'Camera', family: 'camera', description: 'Crop مستطيل هندسي نظيف.' },
  { type: 'distance', name: 'Depth Distance', short: 'DP', category: 'Camera', family: 'camera', description: 'إحساس عمق ومسافة بين اللقطتين.' },

  { type: 'wipeleft', name: 'Wipe Left', short: 'WL', category: 'Motion', family: 'wipe', direction: 'left', description: 'مسح أفقي إلى اليسار.' },
  { type: 'wiperight', name: 'Wipe Right', short: 'WR', category: 'Motion', family: 'wipe', direction: 'right', description: 'مسح أفقي إلى اليمين.' },
  { type: 'wipeup', name: 'Wipe Up', short: 'WU', category: 'Motion', family: 'wipe', direction: 'up', description: 'مسح رأسي إلى الأعلى.' },
  { type: 'wipedown', name: 'Wipe Down', short: 'WD', category: 'Motion', family: 'wipe', direction: 'down', description: 'مسح رأسي إلى الأسفل.' },
  { type: 'slideleft', name: 'Slide Left', short: 'SL', category: 'Motion', family: 'slide', direction: 'left', description: 'دفع اللقطة التالية من اليمين.' },
  { type: 'slideright', name: 'Slide Right', short: 'SR', category: 'Motion', family: 'slide', direction: 'right', description: 'دفع اللقطة التالية من اليسار.' },
  { type: 'slideup', name: 'Slide Up', short: 'SU', category: 'Motion', family: 'slide', direction: 'up', description: 'دفع رأسي إلى الأعلى.' },
  { type: 'slidedown', name: 'Slide Down', short: 'SD', category: 'Motion', family: 'slide', direction: 'down', description: 'دفع رأسي إلى الأسفل.' },
  { type: 'smoothleft', name: 'Smooth Left', short: 'ML', category: 'Motion', family: 'smooth', direction: 'left', description: 'حركة جانبية ناعمة بمنحنى سلس.' },
  { type: 'smoothright', name: 'Smooth Right', short: 'MR', category: 'Motion', family: 'smooth', direction: 'right', description: 'حركة جانبية ناعمة إلى اليمين.' },
  { type: 'smoothup', name: 'Smooth Up', short: 'MU', category: 'Motion', family: 'smooth', direction: 'up', description: 'حركة صاعدة ناعمة.' },
  { type: 'smoothdown', name: 'Smooth Down', short: 'MD', category: 'Motion', family: 'smooth', direction: 'down', description: 'حركة هابطة ناعمة.' },
  { type: 'diagtl', name: 'Diagonal TL', short: 'DT', category: 'Motion', family: 'diagonal', description: 'Wipe قطري نحو أعلى اليسار.' },
  { type: 'diagtr', name: 'Diagonal TR', short: 'DR', category: 'Motion', family: 'diagonal', description: 'Wipe قطري نحو أعلى اليمين.' },
  { type: 'diagbl', name: 'Diagonal BL', short: 'DB', category: 'Motion', family: 'diagonal', description: 'Wipe قطري نحو أسفل اليسار.' },
  { type: 'diagbr', name: 'Diagonal BR', short: 'DG', category: 'Motion', family: 'diagonal', description: 'Wipe قطري نحو أسفل اليمين.' },

  { type: 'fadewhite', name: 'White Flash', short: 'WF', category: 'Light', family: 'light', description: 'Flash أبيض للمقاطع الدعائية والسريعة.', alias: true },
  { type: 'fadefast', name: 'Flash Fade', short: 'FX', category: 'Light', family: 'light', description: 'انتقال سريع بإحساس Flash.', alias: true },
  { type: 'hlwind', name: 'Light Sweep Left', short: 'LL', category: 'Light', family: 'wind', direction: 'left', description: 'Sweep أفقي مضيء من اليسار.' },
  { type: 'hrwind', name: 'Light Sweep Right', short: 'LR', category: 'Light', family: 'wind', direction: 'right', description: 'Sweep أفقي مضيء من اليمين.' },
  { type: 'vuwind', name: 'Light Sweep Up', short: 'LU', category: 'Light', family: 'wind', direction: 'up', description: 'Sweep رأسي مضيء إلى الأعلى.' },
  { type: 'vdwind', name: 'Light Sweep Down', short: 'LD', category: 'Light', family: 'wind', direction: 'down', description: 'Sweep رأسي مضيء إلى الأسفل.' },

  { type: 'pixelize', name: 'Pixelize', short: 'PX', category: 'Glitch', family: 'glitch', description: 'Pixel breakup رقمي.' },
  { type: 'hlslice', name: 'Slice Left', short: 'GL', category: 'Glitch', family: 'slice', direction: 'left', description: 'شرائح أفقية متقطعة من اليسار.' },
  { type: 'hrslice', name: 'Slice Right', short: 'GR', category: 'Glitch', family: 'slice', direction: 'right', description: 'شرائح أفقية متقطعة من اليمين.' },
  { type: 'vuslice', name: 'Slice Up', short: 'GU', category: 'Glitch', family: 'slice', direction: 'up', description: 'شرائح رأسية صاعدة.' },
  { type: 'vdslice', name: 'Slice Down', short: 'GD', category: 'Glitch', family: 'slice', direction: 'down', description: 'شرائح رأسية هابطة.' },

  { type: 'coverleft', name: 'Cover Left', short: 'CL', category: '3D', family: 'cover', direction: 'left', description: 'اللقطة التالية تغطي الحالية من اليمين.' },
  { type: 'coverright', name: 'Cover Right', short: 'CR', category: '3D', family: 'cover', direction: 'right', description: 'تغطية ثلاثية الإحساس من اليسار.' },
  { type: 'coverup', name: 'Cover Up', short: 'CU', category: '3D', family: 'cover', direction: 'up', description: 'تغطية صاعدة للمشهد.' },
  { type: 'coverdown', name: 'Cover Down', short: 'CD', category: '3D', family: 'cover', direction: 'down', description: 'تغطية هابطة للمشهد.' },
  { type: 'revealleft', name: 'Reveal Left', short: 'RL', category: '3D', family: 'reveal', direction: 'left', description: 'سحب اللقطة الحالية لكشف التالية.' },
  { type: 'revealright', name: 'Reveal Right', short: 'RR', category: '3D', family: 'reveal', direction: 'right', description: 'كشف المشهد التالي باتجاه اليمين.' },
  { type: 'revealup', name: 'Reveal Up', short: 'RU', category: '3D', family: 'reveal', direction: 'up', description: 'كشف رأسي صاعد.' },
  { type: 'revealdown', name: 'Reveal Down', short: 'RD', category: '3D', family: 'reveal', direction: 'down', description: 'كشف رأسي هابط.' },
  { type: 'squeezeh', name: 'Squeeze Horizontal', short: 'QH', category: '3D', family: 'squeeze', description: 'ضغط أفقي يفتح اللقطة التالية.' },
  { type: 'squeezev', name: 'Squeeze Vertical', short: 'QV', category: '3D', family: 'squeeze', description: 'ضغط رأسي يفتح اللقطة التالية.' },
  { type: 'circleopen', name: 'Circle Open', short: 'CO', category: '3D', family: 'shape', description: 'فتح دائري من مركز الصورة.' },
  { type: 'circleclose', name: 'Circle Close', short: 'CX', category: '3D', family: 'shape', description: 'إغلاق دائري ثم كشف المشهد.' },
  { type: 'vertopen', name: 'Vertical Open', short: 'VO', category: '3D', family: 'shape', description: 'فتح رأسي هندسي.' },
  { type: 'vertclose', name: 'Vertical Close', short: 'VC', category: '3D', family: 'shape', description: 'إغلاق رأسي هندسي.' },
  { type: 'horzopen', name: 'Horizontal Open', short: 'HO', category: '3D', family: 'shape', description: 'فتح أفقي هندسي.' },
  { type: 'horzclose', name: 'Horizontal Close', short: 'HC', category: '3D', family: 'shape', description: 'إغلاق أفقي هندسي.' },
] as const

export type TransitionDefinition = (typeof TRANSITION_LIBRARY)[number]
export type TransitionType = TransitionDefinition['type']

export const TRANSITION_CATEGORIES: TransitionCategory[] = ['Basic', 'Film', 'Camera', 'Motion', 'Light', 'Glitch', '3D']
export const TRANSITION_EASINGS: Array<{ value: TransitionEasing; label: string; description: string }> = [
  { value: 'linear', label: 'Linear', description: 'استجابة مباشرة وسريعة.' },
  { value: 'smooth', label: 'Smooth', description: 'منحنى أكثر نعومة للحركة والصوت.' },
  { value: 'cinematic', label: 'Cinematic', description: 'Crossfade صوتي أهدأ وإيقاع بصري سينمائي.' },
]

const byType = new Map<TransitionType, TransitionDefinition>()
for (const item of TRANSITION_LIBRARY) if (!byType.has(item.type)) byType.set(item.type, item)

export function transitionDefinition(type: string | null | undefined) {
  return byType.get(String(type || 'none') as TransitionType) || byType.get('none')!
}

export function transitionShortName(type: string | null | undefined) {
  return transitionDefinition(type).short
}

export function transitionDirection(type: string | null | undefined): TransitionDirection | null {
  const item = transitionDefinition(type)
  return 'direction' in item ? item.direction as TransitionDirection : null
}

const directionalFamilies: Record<string, Partial<Record<TransitionDirection, TransitionType>>> = {
  wipe: { left: 'wipeleft', right: 'wiperight', up: 'wipeup', down: 'wipedown' },
  slide: { left: 'slideleft', right: 'slideright', up: 'slideup', down: 'slidedown' },
  smooth: { left: 'smoothleft', right: 'smoothright', up: 'smoothup', down: 'smoothdown' },
  wind: { left: 'hlwind', right: 'hrwind', up: 'vuwind', down: 'vdwind' },
  slice: { left: 'hlslice', right: 'hrslice', up: 'vuslice', down: 'vdslice' },
  cover: { left: 'coverleft', right: 'coverright', up: 'coverup', down: 'coverdown' },
  reveal: { left: 'revealleft', right: 'revealright', up: 'revealup', down: 'revealdown' },
}

export function supportsDirection(type: string | null | undefined) {
  return Boolean(directionalFamilies[transitionDefinition(type).family])
}

export function resolveDirectionalTransition(type: TransitionType, direction: TransitionDirection, easing: TransitionEasing): TransitionType {
  const item = transitionDefinition(type)
  let family = item.family
  if (easing !== 'linear' && family === 'slide') family = 'smooth'
  const candidate = directionalFamilies[family]?.[direction]
  return candidate || type
}
