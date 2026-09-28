-- ============================================================================
-- 003_resource_seed_data.sql
-- Development seed data ONLY — realistic equipment, no fake users or fake
-- activity. Additive + idempotent (ON CONFLICT DO NOTHING keyed by asset_code).
-- Safe to run on a fresh 002-migrated database; safe to re-run.
-- Run:  psql -U <user> -d incuportal -f migrations/003_resource_seed_data.sql
-- ============================================================================

DO $$
DECLARE
  cat_electronics INT; cat_computing INT; cat_robotics INT; cat_fabrication INT;
  cat_lab INT; cat_avspace INT; cat_meeting INT;
BEGIN
  SELECT id INTO cat_electronics FROM resource_categories WHERE name = 'Electronics';
  SELECT id INTO cat_computing   FROM resource_categories WHERE name = 'Computing';
  SELECT id INTO cat_robotics    FROM resource_categories WHERE name = 'Robotics';
  SELECT id INTO cat_fabrication FROM resource_categories WHERE name = 'Fabrication';
  SELECT id INTO cat_lab         FROM resource_categories WHERE name = 'Laboratory';
  SELECT id INTO cat_avspace     FROM resource_categories WHERE name = 'Audio/Visual';
  SELECT id INTO cat_meeting     FROM resource_categories WHERE name = 'Meeting Rooms';

  -- Issuable electronics/computing (quantity > 1 where it's genuinely stocked)
  INSERT INTO resources (asset_code, name, category_id, resource_type, brand, model, quantity, unit, location, condition, status, description, purchase_date, purchase_cost, warranty_expiry) VALUES
    ('ARD-001', 'Arduino Mega Kit',       cat_electronics, 'ISSUABLE', 'Arduino',    'Mega 2560', 8, 'kit', 'Innovation Lab — Shelf A2', 'GOOD', 'AVAILABLE', 'Arduino Mega 2560 with breadboard, jumper wires and a starter sensor pack.', '2026-01-15', 1800, '2028-01-15'),
    ('RPI-001', 'Raspberry Pi 5',         cat_computing,   'ISSUABLE', 'Raspberry Pi','5 (8GB)',  5, 'unit', 'Innovation Lab — Shelf A1', 'NEW',  'AVAILABLE', 'Raspberry Pi 5, 8GB RAM, with power supply and 32GB SD card.', '2026-06-01', 6500, '2028-06-01'),
    ('ESP-001', 'ESP32 Development Kit',  cat_electronics, 'ISSUABLE', 'Espressif',  'ESP32-WROOM', 10, 'unit', 'Innovation Lab — Shelf A3', 'GOOD', 'AVAILABLE', 'ESP32 dev board with WiFi/Bluetooth, USB-C cable included.', '2026-02-10', 650, NULL),
    ('LAP-001', 'Dell Latitude Laptop',   cat_computing,   'ISSUABLE', 'Dell',       'Latitude 5440', 3, 'unit', 'Co-working Floor', 'GOOD', 'AVAILABLE', 'Loaner laptop for teams without their own hardware, i5/16GB/512GB.', '2025-11-20', 62000, '2027-11-20'),
    ('ROB-001', 'Robotics Starter Kit',   cat_robotics,    'ISSUABLE', 'TurtleBot',  'Basic',     4, 'kit', 'Innovation Lab — Shelf B1', 'GOOD', 'AVAILABLE', 'Chassis, motors, motor driver and ultrasonic sensor for a basic rover build.', '2026-03-05', 4200, NULL)
  ON CONFLICT (asset_code) DO NOTHING;

  -- Single-unit issuable lab equipment
  INSERT INTO resources (asset_code, name, category_id, resource_type, brand, model, quantity, unit, location, condition, status, description, purchase_date, purchase_cost, warranty_expiry) VALUES
    ('DMM-001', 'Digital Multimeter',     cat_lab, 'ISSUABLE', 'Fluke', '115',        1, 'unit', 'Electronics Lab', 'GOOD', 'AVAILABLE', 'True-RMS digital multimeter for voltage, current and continuity testing.', '2025-08-12', 8500, '2027-08-12'),
    ('OSC-001', 'Digital Oscilloscope',   cat_lab, 'ISSUABLE', 'Rigol', 'DS1054Z',    1, 'unit', 'Electronics Lab', 'GOOD', 'AVAILABLE', '4-channel, 50MHz digital oscilloscope.', '2025-08-12', 32000, '2027-08-12'),
    ('SOL-001', 'Soldering Station',      cat_lab, 'ISSUABLE', 'Weller', 'WE1010',    1, 'unit', 'Electronics Lab', 'GOOD', 'AVAILABLE', 'Temperature-controlled soldering iron with stand and sponge.', '2025-09-01', 7200, NULL)
  ON CONFLICT (asset_code) DO NOTHING;

  -- Bookable machines and spaces (always quantity = 1)
  INSERT INTO resources (asset_code, name, category_id, resource_type, brand, model, quantity, unit, location, condition, status, description, purchase_date, purchase_cost, warranty_expiry) VALUES
    ('3DP-001', '3D Printer',             cat_fabrication, 'BOOKABLE', 'Prusa', 'MK4',        1, 'unit', 'Fabrication Bay', 'GOOD', 'AVAILABLE', 'FDM 3D printer, 250x210x220mm build volume. Bring your own filament or use lab PLA.', '2026-01-20', 95000, '2028-01-20'),
    ('LSR-001', 'Laser Cutter',           cat_fabrication, 'BOOKABLE', 'Glowforge', 'Pro',    1, 'unit', 'Fabrication Bay', 'GOOD', 'AVAILABLE', '45W CO2 laser cutter/engraver. Induction required before first use.', '2025-12-05', 280000, '2027-12-05'),
    ('CNC-001', 'Desktop CNC Machine',    cat_fabrication, 'BOOKABLE', 'Carbide 3D', 'Shapeoko 4', 1, 'unit', 'Fabrication Bay', 'GOOD', 'AVAILABLE', 'Desktop CNC router for wood, plastic and soft metals.', '2026-02-14', 145000, '2028-02-14'),
    ('LAB-001', 'Electronics Lab (bay)',  cat_lab, 'FACILITY', NULL, NULL,             1, 'slot', 'Ground Floor', 'GOOD', 'AVAILABLE', 'Shared electronics workbench with power supplies and test equipment.', NULL, NULL, NULL),
    ('CNF-001', 'Conference Room A',      cat_meeting, 'FACILITY', NULL, NULL,        1, 'slot', 'First Floor', 'GOOD', 'AVAILABLE', 'Seats 8. Projector and whiteboard included.', NULL, NULL, NULL),
    ('CAM-001', 'DSLR Camera Kit',        cat_avspace, 'BOOKABLE', 'Canon', 'EOS 250D', 1, 'unit', 'Media Room', 'GOOD', 'AVAILABLE', 'DSLR with 18-55mm lens, tripod and SD card — for demo-day filming.', '2025-10-10', 48000, '2027-10-10')
  ON CONFLICT (asset_code) DO NOTHING;

  -- Keep the asset-code counters in sync so admin-created resources never collide
  -- with these seeded codes (e.g. the next Arduino kit becomes ARD-002, not ARD-001).
  INSERT INTO resource_code_counters (prefix, last_number) VALUES
    ('ARD', 1), ('RPI', 1), ('ESP', 1), ('LAP', 1), ('ROB', 1),
    ('DMM', 1), ('OSC', 1), ('SOL', 1),
    ('3DP', 1), ('LSR', 1), ('CNC', 1), ('LAB', 1), ('CNF', 1), ('CAM', 1)
  ON CONFLICT (prefix) DO UPDATE SET last_number = GREATEST(resource_code_counters.last_number, EXCLUDED.last_number);
END $$;
