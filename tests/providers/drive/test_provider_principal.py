import json
from pathlib import Path
import pytest
from papeer.core.providers.drive.principal import google_drive_principal_digest


def test_principal_domain_vectors_are_shared_with_typescript():
    vectors = json.loads((Path(__file__).resolve().parents[2] / 'fixtures/provider/principal-vectors.json').read_text('utf8'))
    for value in vectors['valid']:
        assert google_drive_principal_digest(value['permissionId']) == value['sha256']
    for value in vectors['invalid']:
        with pytest.raises(ValueError, match='drive-principal-invalid'):
            google_drive_principal_digest(value)

