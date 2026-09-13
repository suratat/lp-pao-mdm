// RFC 9457 application/problem+json - §2.4 ของเอกสารออกแบบ
class HttpProblem extends Error {
  constructor(status, type, title, detail, extra = {}) {
    super(detail || title);
    this.status = status;
    this.type = type; // ส่วนท้ายของ URI เช่น 'insufficient-scope' (ประกอบเป็น URI เต็มใน problemJson middleware)
    this.title = title;
    this.detail = detail;
    this.extra = extra;
  }
}

module.exports = { HttpProblem };
