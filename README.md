# 계명대학교 성서캠퍼스 3D

three.js로 만든 계명대학교 성서캠퍼스(대구 달서구) 3D 모델입니다. 빌드 과정이 없어서 정적 서버만 있으면 됩니다.

```bash
python3 scripts/serve.py      # 캐시를 끈 개발 서버, http://localhost:8080
```

## 기능
- 궤도 카메라: 드래그로 이동, 우클릭 드래그로 회전, 휠로 확대/축소
- 건물 이름표: 주요 건물은 멀리서도 보이고, 나머지는 가까이 가면 나타남
- 건물 클릭: 정보 패널(분류, 층수, 높이, 바닥 면적, OSM 링크)
- 왼쪽 목록: 분류별 건물 목록과 검색. 항목을 누르면 카메라가 이동
- 낮/밤 전환: 밤에는 창문, 가로등, 시계탑이 켜짐
- 지형: 공개 고도 데이터로 만든 경사지와 뒷산(4.8 km 상세 + 36 km 원경), 숲이 우거진 산자락
- 실사 재질: 실제 사진으로 만든 CC0 PBR 텍스처(벽돌, 슬레이트, 콘크리트, 기와), HDRI 하늘과 반사광, 창문 반사와 밤 조명
- 건물별 외관: 계명대 공식 성서캠퍼스 안내도를 참고한 벽·지붕 색과 지붕 형태. ㄱ·ㄷ·십자형 건물은 날개마다 지붕을 얹음
- 대표 건물 디테일: 행소관(본관) 흰 시계탑과 포르티코, 아담스채플 돔 탑, 계명아트센터 반원 열주·포르티코·무대탑, 동천관 원형 열주와 돔, 계명한학촌 기와지붕, 정문(가운데 페디먼트 게이트와 양쪽 이오니아식 열주 파빌리온, 벽돌 포장 광장, 수위실)

## 구조
| 파일 | 역할 |
| --- | --- |
| `scripts/fetch_osm.py` | Overpass API로 건물, 도로, 녹지, 캠퍼스 경계를 받아 `data/campus.json` 생성 |
| `scripts/import_shp.py` | 국토교통부 GIS건물통합정보 SHP로 `data/campus.json`의 건물 외곽선·층수·높이를 교체 (OSM 원본은 `data/campus.osm.json`에 보관) |
| `scripts/fetch_terrain.py` | 공개 고도 타일(Terrain Tiles)을 받아 `assets/terrain/`에 지형 격자 생성 |
| `scripts/serve.py` | 캐시를 끈 개발 서버 |
| `data/buildings_meta.json` | 건물별 표시 이름, 분류, 설명, 추정 층수, 벽·지붕 색과 형태, 디테일(수작업, 안내도 참고) |
| `assets/textures`, `assets/hdri` | Poly Haven CC0 텍스처와 HDRI 하늘 |
| `src/geo.js` | 위경도 → 로컬 미터 투영, OBB, PRNG |
| `src/terrain.js` | 지형 격자 로드, 높이 조회, 지형 메시 |
| `src/buildings.js` | 외곽선 돌출, 사진 텍스처 + 창문 아틀라스 셰이더, 건물별 재질, 선택 강조 |
| `src/landmarks.js` | 지붕(날개별 박공·모임·볼트)과 디테일 생성기 |
| `src/uv.js` | 텍스처를 실제 크기로 입히는 UV 도우미 |
| `src/ground.js` | 지형 위에 칠한 잔디·도로·운동장, 나무와 숲, 가로등 |
| `src/labels.js`, `src/ui.js` | 이름표, 목록, 검색, 정보 패널 |
| `src/main.js` | 장면, 조명, 하늘, 낮/밤, 카메라 이동, 클릭 선택 |

## 데이터 다시 받기
```bash
python3 scripts/fetch_osm.py       # 건물·도로·녹지 (OSM)
python3 scripts/fetch_terrain.py   # 지형
```
가져온 데이터를 바꾸기 전에 미리 보려면 `http://localhost:8080/?data=data/다른파일.json`으로 다른 campus.json을 열 수 있습니다.

### 건물을 GIS건물통합정보로 바꾸기
국토교통부 GIS건물통합정보(건축물대장 기반 건물 외곽선, 지상층수, 높이)로 캠퍼스 범위의 건물을 교체할 수 있습니다. 도로, 녹지, 캠퍼스 경계는 OSM 그대로 둡니다. Python 표준 라이브러리만 씁니다.

1. [브이월드](https://www.vworld.kr) 공간정보 다운로드에서 'GIS건물통합정보'를 찾아 대구광역시 SHP를 받습니다(로그인 필요). 압축을 풀면 `.shp/.shx/.dbf/.prj`(가끔 `.cpg`)가 한 폴더에 있어야 합니다.
2. 먼저 `--dry-run`으로 확인합니다. DBF 필드 목록, 샘플 3건, 이름·층수·높이 통계, 캠퍼스 건물 표를 출력하고 아무것도 쓰지 않습니다.
   ```bash
   python3 scripts/import_shp.py ~/Downloads/AL_D010_27_XXXXXXXX.shp --dry-run
   ```
   필드를 못 찾으면 `--name-field A24 --dong-field A25 --floors-field A26 --height-field A16 --use-field A9 --id-field A1`처럼 직접 지정합니다.
3. 결과가 괜찮으면 `--dry-run` 없이 실행합니다. 처음 실행할 때 OSM 버전을 `data/campus.osm.json`으로 백업합니다.

- 좌표계는 `.prj`에서 읽습니다. EPSG:5186(2023년 8월 이후 배포본), 5179 등 그리니치 기준 GRS80 횡메르카토르만 지원합니다. 옛 Bessel 파일(EPSG:5174)이나 그리니치가 아닌 본초자오선은 오류로 멈추니 새 파일을 받거나 `ogr2ogr -t_srs EPSG:5186`으로 변환하세요. `.prj`가 없으면 `--crs 5186`을 붙입니다.
- 인코딩: `.cpg`가 있으면 쓰되, 실제 데이터가 그 인코딩으로 안 읽히면 경고를 내고 cp949/utf-8 자동 판별로 바꿉니다. `--encoding`으로 직접 지정할 수 있습니다(`euc-kr`은 cp949로 읽음).
- 건물 이름: OSM 건물과 겹치면 OSM 이름을 그대로 써서 `buildings_meta.json` 키가 계속 맞습니다. 아니면 건물동명(A25)을 쓰고, '제1동', '주건축물제1동', '경비실' 같은 일반 동명칭이면 건물명(A24)을 씁니다. 다만 화면은 같은 이름의 건물을 하나로 묶으므로, A24가 다른 건물과 겹치면(예: 모두 '계명대학교') 'A24 A25'가 유일할 때만 그 이름을 쓰고 아니면 이름을 비웁니다. 실행 결과의 "OSM names with no SHP match" 목록에 나온 이름은 메타데이터와 연결이 끊긴 것이니 확인하세요.
- 캠퍼스 건물: 캠퍼스 OSM 건물과 겹치면 용도(A9)와 관계없이 캠퍼스 건물입니다. 겹치지 않으면 캠퍼스 경계 안이고 용도가 공동주택·단독주택·종교·근린생활시설이 아닐 때 캠퍼스 건물로 봅니다. 단, 용도·건물명·동명칭에 '대학', '기숙사', '생활관'이 있으면(대학 채플, 기숙사) 캠퍼스 건물입니다. 이름이 같은 건물은 캠퍼스 여부도 같게 맞춥니다.
- 층수·높이: 대장에 지상층수(A26)나 높이(A16)가 없고 겹치는 OSM 건물에 값이 있으면 OSM 값을 쓰고 `levels:source`/`height:source`를 `osm`으로 표시합니다. 가져온 건물에는 모두 `reg:id`(A1, 없으면 `#레코드번호`)가 붙습니다.
- 범위 경계: 대장과 OSM 외곽선은 몇 m씩 어긋나므로, 범위 경계에 걸친 건물은 짝지어 한 번만 판단합니다(중복되거나 사라지지 않음).
- 되돌리기: `cp data/campus.osm.json data/campus.json`. `fetch_osm.py`로 OSM을 새로 받은 뒤에는 `import_shp.py`를 다시 실행하면 됩니다. 이때 내용이 다른 기존 백업은 덮어쓰지 않고 `data/campus.osm.<날짜-시각>.json`으로 이름을 바꿔 남깁니다.
- 테스트: `python3 -m unittest discover -s tests`

## 정확도에 대해
- 건물 외곽선과 위치는 OpenStreetMap 데이터입니다. OSM에 등록되지 않은 건물(일부 기숙사 등)은 모델에 없습니다. GIS건물통합정보를 가져오면 캠퍼스 범위 건물은 건축물대장 외곽선으로 바뀌고, 지상층수(A26)와 높이(A16)가 있으면 그 값을 씁니다.
- **층수는 건축물대장 → OSM → 추정값 순서로 씁니다.** 추정값은 공식 캠퍼스 안내도에서 보이는 층 수로 정했고, 정보 패널에 출처(건축물대장/OSM 기준/추정)를 표시합니다. `data/buildings_meta.json`의 `floors`를 고치면 바로 반영됩니다.
- 벽·지붕 색과 지붕 형태는 계명대 공식 성서캠퍼스 안내도(일러스트)를 참고했습니다. 일러스트는 밝고 연무가 끼어 있어 실제 재료 톤으로 보정했습니다. 안내도 이미지 자체는 저장소에 넣지 않았습니다.
- 지형은 약 30 m 해상도의 전 세계 고도 데이터라 작은 옹벽이나 계단 같은 세부는 없습니다. 경사지 건물은 발밑 가장 낮은 지점에 앉힙니다.
- 정문과 정문수위실은 건축물대장에 외곽선 없이 점으로만 있어 로드뷰 사진을 참고해 따로 모델링했습니다. 대장의 두 점은 위치가 서로 바뀐 것으로 보여(사진에서는 게이트가 입구 쪽, 수위실이 안쪽), 게이트를 입구 쪽 점에, 수위실을 안쪽 점에 두었습니다(`buildings_meta.json`의 `shift`).
- 지붕 모양과 디테일은 실제 건물을 단순화한 표현입니다.

## 출처
- 지도 데이터 © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL 1.0
- GIS건물통합정보를 가져온 경우 건물: 국토교통부 GIS건물통합정보 (브이월드), CC BY
- 지형: Terrain Tiles (Mapzen, AWS Open Data) · SRTM, GMTED2010 (USGS), ETOPO1 (NOAA)
- 텍스처·HDRI: [Poly Haven](https://polyhaven.com) (CC0) — red_brick_03, roof_slates_02, concrete_wall_004, grey_roof_tiles, kloofendal_48d_partly_cloudy_puresky
