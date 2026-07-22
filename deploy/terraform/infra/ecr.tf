resource "aws_ecr_repository" "this" {
  for_each = toset(["valet-api", "valet-sandbox"])

  name                 = each.key
  image_tag_mutability = "MUTABLE"
  force_delete         = true # dev/staging: allow terraform destroy with images present
}

resource "aws_ecr_lifecycle_policy" "keep_last_10" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
