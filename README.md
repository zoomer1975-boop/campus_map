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
- 대표 건물 디테일: 본관 시계탑, 아담스채플관 첨탑, 동산도서관 열주, 행소박물관 돔, 계명아트센터 유리 외벽과 무대탑, 한학촌 기와지붕. 직사각형 벽돌 건물에는 박공지붕을 얹음

## 구조
| 파일 | 역할 |
| --- | --- |
| `scripts/fetch_osm.py` | Overpass API로 건물, 도로, 녹지, 캠퍼스 경계를 받아 `data/campus.json` 생성 |
| `scripts/import_shp.py` | 국토교통부 GIS건물통합정보 SHP로 `data/campus.json`의 건물 외곽선·층수·높이를 교체 (OSM 원본은 `data/campus.osm.json`에 보관) |
| `data/buildings_meta.json` | 건물별 층수, 분류, 설명, 디테일 종류, 이름 보정 (수작업) |
| `src/geo.js` | 위경도 → 로컬 미터 투영, OBB, PRNG |
| `src/buildings.js` | 외곽선 돌출, 창문 파사드 텍스처(canvas), 선택 강조 |
| `src/landmarks.js` | 대표 건물 디테일 생성기 |
| `src/ground.js` | 지면, 도로, 녹지, 나무, 가로등 |
| `src/labels.js`, `src/ui.js` | 이름표, 목록, 검색, 정보 패널 |
| `src/main.js` | 장면, 조명, 하늘, 낮/밤, 카메라 이동, 클릭 선택 |

## 데이터 다시 받기
```bash
python3 scripts/fetch_osm.py
```

### 건물을 GIS건물통합정보로 바꾸기
국토교통부 GIS건물통합정보(건축물대장 기반 건물 외곽선, 지상층수, 높이)로 캠퍼스 범위의 건물을 교체할 수 있습니다. 도로, 녹지, 캠퍼스 경계는 OSM 그대로 둡니다. Python 표준 라이브러리만 씁니다.

1. [브이월드](https://www.vworld.kr) 공간정보 다운로드에서 'GIS건물통합정보'를 찾아 대구광역시 SHP를 받습니다(로그인 필요). 압축을 풀면 `.shp/.shx/.dbf/.prj`(가끔 `.cpg`)가 한 폴더에 있어야 합니다.
2. 먼저 `--dry-run`으로 확인합니다. DBF 필드 목록, 샘플 3건, 이름·층수·높이 통계, 캠퍼스 건물 표를 출력하고 아무것도 쓰지 않습니다.
   ```bash
   python3 scripts/import_shp.py ~/Downloads/AL_D010_27_XXXXXXXX.shp --dry-run
   ```
   필드를 못 찾으면 `--name-field A24 --dong-field A25 --floors-field A26 --height-field A16 --use-field A9 --id-field A1`처럼 직접 지정합니다.
3. 결과가 괜찮으면 `--dry-run` 없이 실행합니다. 처음 실행할 때 OSM 버전을 `data/campus.osm.json`으로 백업합니다.

- 좌표계는 `.prj`에서 읽습니다. EPSG:5186(2023년 8월 이후 배포본), 5179 등 GRS80 횡메르카토르만 지원합니다. 옛 Bessel 파일(EPSG:5174)은 오류로 멈추니 새 파일을 받거나 `ogr2ogr -t_srs EPSG:5186`으로 변환하세요. `.prj`가 없으면 `--crs 5186`을 붙입니다.
- 건물 이름: OSM 건물과 겹치면 OSM 이름을 그대로 써서 `buildings_meta.json` 키가 계속 맞습니다. 아니면 건물동명(A25), 그다음 건물명(A24)을 씁니다. 실행 결과의 "OSM names with no SHP match" 목록에 나온 이름은 메타데이터와 연결이 끊긴 것이니 확인하세요.
- 되돌리기: `cp data/campus.osm.json data/campus.json`. `fetch_osm.py`로 OSM을 새로 받은 뒤에는 `import_shp.py`를 다시 실행하면 됩니다.
- 테스트: `python3 -m unittest discover -s tests`

## 정확도에 대해
- 건물 외곽선과 위치는 OpenStreetMap 데이터입니다. OSM에 등록되지 않은 건물(일부 기숙사 등)은 모델에 없습니다. GIS건물통합정보를 가져오면 캠퍼스 범위 건물은 건축물대장 외곽선으로 바뀌고, 지상층수(A26)와 높이(A16)가 있으면 그 값을 씁니다.
- **층수는 대부분 추정값입니다.** 동산병원처럼 OSM에 층수가 있는 경우만 그 값을 씁니다. `data/buildings_meta.json`의 `floors`를 고치면 바로 반영됩니다.
- 지붕 모양과 디테일은 실제 건물을 단순화한 표현입니다.

지도 데이터 © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL 1.0
(GIS건물통합정보를 가져온 경우 건물: 국토교통부 GIS건물통합정보 (브이월드), CC BY)
