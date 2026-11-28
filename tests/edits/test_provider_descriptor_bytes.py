import json
from pathlib import Path
import pytest
from papeer.core.edits.provider_descriptor_bytes import read_provider_descriptor_bytes

VECTORS = json.loads((Path(__file__).parent.parent / 'fixtures/provider-descriptor-bytes.json').read_text(encoding='utf-8'))


@pytest.mark.parametrize('vector', VECTORS['cases'], ids=lambda vector: vector['name'])
def test_provider_descriptor_bytes(vector):
    data = bytes.fromhex(vector['bytesHex'])
    if vector['ok']:
        result = read_provider_descriptor_bytes(data, vector['expectedSha256'], vector['scope'])
        assert result == {'descriptor': vector.get('expectedDescriptor', VECTORS['valid']), 'sha256': vector['expectedSha256']}
    else:
        with pytest.raises(ValueError):
            read_provider_descriptor_bytes(data, vector['expectedSha256'], vector['scope'])
