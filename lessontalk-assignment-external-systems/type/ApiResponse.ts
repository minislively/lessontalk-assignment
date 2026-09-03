// 벤더 응답 형태. 정상 응답의 모양만 담았고, 명세에 없는 값이 섞여 오는 경우는 빠져 있다.
// 전체 명세는 Swagger(:8800).
//
// 예약 조회는 세 벤더 모두 매장×날짜 단위다. 파라미터 이름이 다르다.
//   매장 storeId / shopCode / SHOP_ID,  날짜 date / searchDate / DATE

/** GET :8801/stores */
export interface VendorAStoresResponse {
  list: { storeId: string; storeName: string }[];
}

/** GET :8801/bookings?storeId=A-1001&date=YYYY-MM-DD&page=1 */
export interface VendorABookingsResponse {
  list: {
    bookingId: string;
    storeId: string;
    memberId: string;
    memberName: string;
    memberPhone: string; // 010-1234-5678
    startAt: string; // ISO8601, +09:00
    endAt: string;
    instructorId: string; // 프로(강사) 식별자를 주는 벤더는 여기뿐
    instructorName: string;
    instructorPhone: string; // 010-9000-0509
    status: 'RESERVED' | 'CHECKED_IN' | 'CANCELED';
  }[];
  pageInfo: { totalPage: number };
}

/**
 * GET :8802/stores, GET :8802/bookings?shopCode=7701&searchDate=YYYYMMDD&page=1
 *
 * XML 문자열로 온다. 요청의 searchDate 는 무하이픈인데 응답의 lessonDate 는 하이픈이다.
 * 체크인 개념이 없어서 상태는 cancelYn 하나뿐이다.
 *
 * <result><list>
 *   <booking> bookingNo shopCode custName custPhone lessonDate beginTime finishTime
 *             proName proPhone cancelYn </booking>
 * </list><hasNextPage>false</hasNextPage></result>
 */
export type VendorBXmlResponse = string;

/** GET :8803/stores */
export interface VendorCStoresResponse {
  shopList: { SHOP_ID: string; SHOP_NAME: string }[];
}

/** POST :8803/bookings — body {"SHOP_ID":"C-05","DATE":"YYYY-MM-DD","page":1} */
export interface VendorCBookingsResponse {
  bookingList: {
    BOOKING_ID: string;
    SHOP_ID: string;
    USER_NAME: string;
    PHONE: string; // +821012345678
    DATE: string; // yyyy-MM-dd
    START_TIME: string; // HH:mm
    END_TIME: string;
    PRO_NAME: string;
    PRO_PHONE: string; // +821090000512
    STATE: string; // 1 예약, 2 체크인, 9 취소, 그 외 값도 온다
  }[];
  page: { totalPageCount: number };
}

/**
 * MESSAGING(:8804) — 수집 벤더가 아니라 발송을 위탁하는 외부 서비스.
 *
 * POST /messages           body { recipientPhone, message, referenceKey? } → 202
 * GET  /messages/{id}      도달 여부. ACCEPTED 로 시작해 DELIVERED 또는 FAILED 로 확정된다
 * GET  /messages?page=1    접수 로그
 *
 * 202 는 접수일 뿐 도달이 아니다. 중복도 걸러 주지 않아서 같은 건을 두 번 보내면
 * 회원이 두 번 받는다. referenceKey 는 해석하지 않고 로그에 그대로 돌려준다.
 */
export interface MessagingAcceptResponse {
  messageId: string;
  acceptedAt: string;
}

export type MessagingStatus = 'ACCEPTED' | 'DELIVERED' | 'FAILED';

export interface MessagingResultResponse {
  messageId: string;
  recipientPhone: string;
  message: string;
  referenceKey: string | null;
  acceptedAt: string;
  status: MessagingStatus;
  resolvedAt: string | null; // DELIVERED·FAILED 로 확정된 시각
  failureReason: string | null;
}

export interface MessagingLogResponse {
  list: MessagingResultResponse[];
  pageInfo: { totalPage: number; totalCount: number };
}
