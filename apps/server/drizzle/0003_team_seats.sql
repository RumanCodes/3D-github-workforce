ALTER TABLE teams ADD COLUMN office_zone serial NOT NULL;
ALTER TABLE office_desks ADD COLUMN team_id text REFERENCES teams(id);
ALTER TABLE office_desks ADD COLUMN team_slot integer;
CREATE UNIQUE INDEX office_team_slot ON office_desks(coalesce(team_id,''),team_slot) WHERE team_slot IS NOT NULL;
