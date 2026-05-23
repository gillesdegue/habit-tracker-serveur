-- Habitudes de test pour Gilles (debut de semaine) + coches semaine du 18 mai 2026
-- user: jillesdegue@gmail.com

BEGIN;

INSERT INTO habits (
  id, user_id, name, description, frequency, schedule_days,
  notification_time, deadline, color, created_at, updated_at
) VALUES
  (
    'habit_test_gilles_lundi',
    'user_1779427318204_h8tno4bc',
    'Sport du lundi',
    'Test - habitude du lundi',
    'Hebdo',
    '[1]',
    '08:00',
    NULL,
    '#FF6B6B',
    '2026-05-01T08:00:00Z',
    NOW()
  ),
  (
    'habit_test_gilles_mardi',
    'user_1779427318204_h8tno4bc',
    'Lecture mardi',
    'Test - habitude du mardi',
    'Hebdo',
    '[2]',
    '20:00',
    NULL,
    '#4ECDC4',
    '2026-05-01T08:00:00Z',
    NOW()
  ),
  (
    'habit_test_gilles_mercredi',
    'user_1779427318204_h8tno4bc',
    'Courses mercredi',
    'Test - habitude du mercredi',
    'Hebdo',
    '[3]',
    '18:00',
    NULL,
    '#95E1D3',
    '2026-05-01T08:00:00Z',
    NOW()
  ),
  (
    'habit_test_gilles_lun_mar',
    'user_1779427318204_h8tno4bc',
    'Planning lun-mar',
    'Test - 2x par semaine debut',
    '2x/semaine',
    '[1,2]',
    '09:00',
    NULL,
    '#F7B500',
    '2026-05-01T08:00:00Z',
    NOW()
  ),
  (
    'habit_test_gilles_eau',
    'user_1779427318204_h8tno4bc',
    'Eau (quotidien)',
    'Test - comparaison quotidien',
    'Quotidien',
    '[]',
    '12:00',
    NULL,
    '#6C63FF',
    '2026-05-01T08:00:00Z',
    NOW()
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  frequency = EXCLUDED.frequency,
  schedule_days = EXCLUDED.schedule_days,
  notification_time = EXCLUDED.notification_time,
  color = EXCLUDED.color,
  updated_at = NOW();

-- Coches : semaine du 18 au 22 mai 2026 (lun=18, mar=19, mer=20, jeu=21, ven=22)
INSERT INTO daily_checks (id, habit_id, date_key, completed, updated_at) VALUES
  -- Lundi 18
  ('check_gilles_sport_0518', 'habit_test_gilles_lundi', '2026-05-18', TRUE, NOW()),
  ('check_gilles_plan_0518', 'habit_test_gilles_lun_mar', '2026-05-18', TRUE, NOW()),
  ('check_gilles_eau_0518', 'habit_test_gilles_eau', '2026-05-18', TRUE, NOW()),
  -- Mardi 19
  ('check_gilles_lect_0519', 'habit_test_gilles_mardi', '2026-05-19', FALSE, NOW()),
  ('check_gilles_plan_0519', 'habit_test_gilles_lun_mar', '2026-05-19', TRUE, NOW()),
  ('check_gilles_eau_0519', 'habit_test_gilles_eau', '2026-05-19', TRUE, NOW()),
  -- Mercredi 20
  ('check_gilles_courses_0520', 'habit_test_gilles_mercredi', '2026-05-20', TRUE, NOW()),
  ('check_gilles_eau_0520', 'habit_test_gilles_eau', '2026-05-20', FALSE, NOW()),
  -- Jeudi 21
  ('check_gilles_eau_0521', 'habit_test_gilles_eau', '2026-05-21', TRUE, NOW()),
  -- Vendredi 22
  ('check_gilles_eau_0522', 'habit_test_gilles_eau', '2026-05-22', FALSE, NOW())
ON CONFLICT (habit_id, date_key) DO UPDATE SET
  completed = EXCLUDED.completed,
  updated_at = NOW();

COMMIT;
